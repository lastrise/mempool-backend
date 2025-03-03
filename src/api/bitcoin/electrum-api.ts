import config from '../../config';
import Client from '@mempool/electrum-client';
import { AbstractBitcoinApi } from './bitcoin-api-abstract-factory';
import { IEsploraApi } from './esplora-api.interface';
import { IElectrumApi } from './electrum-api.interface';
import BitcoinApi from './bitcoin-api';
import logger from '../../logger';
import crypto from "crypto-js";
import loadingIndicators from '../loading-indicators';
import memoryCache from '../memory-cache';

class BitcoindElectrsApi extends BitcoinApi implements AbstractBitcoinApi {
  private electrumClient: any;

  constructor(bitcoinClient: any) {
    super(bitcoinClient);

    const electrumConfig = { client: 'mempool-v2', version: '1.4' };
    const electrumPersistencePolicy = { retryPeriod: 1000, maxRetry: Number.MAX_SAFE_INTEGER, callback: null };

    const electrumCallbacks = {
      onConnect: (client, versionInfo) => { logger.info(`Connected to Electrum Server at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT} (${JSON.stringify(versionInfo)})`); },
      onClose: (client) => { logger.info(`Disconnected from Electrum Server at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT}`); },
      onError: (err) => { logger.err(`Electrum error: ${JSON.stringify(err)}`); },
      onLog: (str) => { logger.debug(str); },
    };

    this.electrumClient = new Client(
      config.ELECTRUM.PORT,
      config.ELECTRUM.HOST,
      config.ELECTRUM.TLS_ENABLED ? 'tls' : 'tcp',
      null,
      electrumCallbacks
    );

    this.electrumClient.initElectrum(electrumConfig, electrumPersistencePolicy)
      .then(() => { })
      .catch((err) => {
        logger.err(`Error connecting to Electrum Server at ${config.ELECTRUM.HOST}:${config.ELECTRUM.PORT}`);
      });
  }

  async $getAddress(address: string): Promise<IEsploraApi.Address> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      return ({
        'address': address,
        'chain_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': 0,
          'spent_txo_count': 0,
          'spent_txo_sum': 0,
          'tx_count': 0
        },
        'mempool_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': 0,
          'spent_txo_count': 0,
          'spent_txo_sum': 0,
          'tx_count': 0
        }
      });
    }

    try {
      const balance = await this.$getScriptHashBalance(addressInfo.scriptPubKey);
      const history = await this.$getScriptHashHistory(addressInfo.scriptPubKey);

      const unconfirmed = history.filter((h) => h.fee).length;

      return {
        'address': addressInfo.address,
        'chain_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.confirmed ? balance.confirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.confirmed < 0 ? balance.confirmed : 0,
          'tx_count': history.length - unconfirmed,
        },
        'mempool_stats': {
          'funded_txo_count': 0,
          'funded_txo_sum': balance.unconfirmed > 0 ? balance.unconfirmed : 0,
          'spent_txo_count': 0,
          'spent_txo_sum': balance.unconfirmed < 0 ? -balance.unconfirmed : 0,
          'tx_count': unconfirmed,
        },
        'electrum': true,
      };
    } catch (e: any) {
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  async $getAddressTransactions(address: string, lastSeenTxId: string): Promise<IEsploraApi.Transaction[]> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      return [];
    }

    try {
      loadingIndicators.setProgress('address-' + address, 0);

      const transactions: IEsploraApi.Transaction[] = [];
      const history = await this.$getScriptHashHistory(addressInfo.scriptPubKey);
      history.sort((a, b) => (b.height || 9999999) - (a.height || 9999999));

      let startingIndex = 0;
      if (lastSeenTxId) {
        const pos = history.findIndex((historicalTx) => historicalTx.tx_hash === lastSeenTxId);
        if (pos) {
          startingIndex = pos + 1;
        }
      }
      const endIndex = Math.min(startingIndex + 10, history.length);

      for (let i = startingIndex; i < endIndex; i++) {
        const tx = await this.$getRawTransaction(history[i].tx_hash, false, true);
        transactions.push(tx);
        loadingIndicators.setProgress('address-' + address, (i + 1) / endIndex * 100);
      }

      return transactions;
    } catch (e: any) {
      loadingIndicators.setProgress('address-' + address, 100);
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  async $getAddressUTXO(address: string): Promise<IEsploraApi.UTXO[]> {
    const addressInfo = await this.bitcoindClient.validateAddress(address);
    if (!addressInfo || !addressInfo.isvalid) {
      return [];
    }

    try {
      const transactions: IEsploraApi.UTXO[] = [];
      const utxos = await this.$getScriptHashUTXO(addressInfo.scriptPubKey);

      for (let utxo of utxos) {
        const tx = await this.$getRawTransaction(utxo.tx_hash, false, true);
        const UTXOConverted: IEsploraApi.UTXO = {
          txid: utxo.tx_hash,
          vout: utxo.tx_pos,
          status: tx.status,
          value: utxo.value
        };
        transactions.push(UTXOConverted);
      }
      return transactions;
    } catch (e: any) {
      throw new Error(typeof e === 'string' ? e : e && e.message || e);
    }
  }

  private $getScriptHashBalance(scriptHash: string): Promise<IElectrumApi.ScriptHashBalance> {
    return this.electrumClient.blockchainScripthash_getBalance(this.encodeScriptHash(scriptHash));
  }

  private $getScriptHashUTXO(scriptHash: string): Promise<IElectrumApi.ScriptHashUTXO[]> {
    const fromCache = memoryCache.get<IElectrumApi.ScriptHashUTXO[]>('Scripthash_listunspent', scriptHash);
    if (fromCache) {
      return Promise.resolve(fromCache);
    }
    return this.electrumClient.blockchainScripthash_listunspent(this.encodeScriptHash(scriptHash))
      .then((utxos) => {
        memoryCache.set('Scripthash_listunspent', scriptHash, utxos, 2);
        return utxos;
      });
  }

  private $getScriptHashHistory(scriptHash: string): Promise<IElectrumApi.ScriptHashHistory[]> {
    const fromCache = memoryCache.get<IElectrumApi.ScriptHashHistory[]>('Scripthash_getHistory', scriptHash);
    if (fromCache) {
      return Promise.resolve(fromCache);
    }
    return this.electrumClient.blockchainScripthash_getHistory(this.encodeScriptHash(scriptHash))
      .then((history) => {
        memoryCache.set('Scripthash_getHistory', scriptHash, history, 2);
        return history;
      });
  }

  private encodeScriptHash(scriptPubKey: string): string {
    const addrScripthash = crypto.enc.Hex.stringify(crypto.SHA256(crypto.enc.Hex.parse(scriptPubKey)));
    return addrScripthash!.match(/.{2}/g)!.reverse().join('');
  }

}

export default BitcoindElectrsApi;
