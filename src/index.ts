'use strict'

import * as crypto from 'crypto'
import * as IlpPacket from 'ilp-packet'

const { Errors } = IlpPacket

import { RippleAPI } from 'ripple-lib'
import BigNumber from 'bignumber.js'
import * as ILDCP from 'ilp-protocol-ildcp'
import StoreWrapper from './store-wrapper'
import { Account, ReadyState } from './account'

import {
  Protocol,
  BtpData,
  Claim,
  Paychan,
  Store
} from './util'

const nacl = require('tweetnacl')
const BtpPacket = require('btp-packet')
const MiniAccountsPlugin = require('ilp-plugin-mini-accounts')

const OUTGOING_CHANNEL_DEFAULT_AMOUNT = Math.pow(10, 6) // 1 XRP
const MIN_INCOMING_CHANNEL = 10000000
const ASSET_SCALE = 6
const ASSET_CODE = 'XRP'

import * as debug from 'debug'
import createLogger = require('ilp-logger')
const DEBUG_NAMESPACE = 'ilp-plugin-xrp-server'

const CHANNEL_KEYS = 'ilp-plugin-multi-xrp-paychan-channel-keys'
const DEFAULT_TIMEOUT = 30000 // TODO: should this be something else?
const {
  createSubmitter,
  util,
  ChannelWatcher
} = require('ilp-plugin-xrp-paychan-shared')

function ilpAddressToAccount (prefix: string, ilpAddress: string) {
  if (ilpAddress.substr(0, prefix.length) !== prefix) {
    throw new Error('ILP address (' + ilpAddress + ') must start with prefix (' + prefix + ')')
  }

  return ilpAddress.substr(prefix.length).split('.')[0]
}

export interface ExtraInfo {
  address: string
  account: string
  currencyScale: number
  channel?: string
  clientChannel?: string
}

export interface IlpPluginAsymServerOpts {
  assetScale?: number
  currencyScale?: number
  maxPacketAmount?: string
  xrpServer: string
  secret: string
  address: string
  maxBalance?: string
  bandwidth?: string
  claimInterval?: number
  _store: Store
  maxFeePercent?: string,
  log: any
}

export default class IlpPluginAsymServer extends MiniAccountsPlugin {
  static version: number = 2
  private _maxPacketAmount: BigNumber
  private _currencyScale: number
  private _xrpServer: string
  private _secret: string
  private _address: string
  private _api: RippleAPI
  private _watcher: any
  private _bandwidth: string
  private _claimInterval: number
  private _store: StoreWrapper
  private _txSubmitter: any
  private _maxFeePercent: string
  private _channelToAccount: Map<string, Account>
  private _accounts: Map<string, Account>
  private _log: any

  constructor (opts: IlpPluginAsymServerOpts) {
    super(opts)

    if (opts.assetScale && opts.currencyScale) {
      throw new Error('opts.assetScale is an alias for opts.currencyScale;' +
        'only one must be specified')
    }

    const currencyScale = opts.assetScale || opts.currencyScale

    // Typescript thinks we don't need to check this, but it's being called
    // from regular javascript so we still need this.
    /* tslint:disable-next-line:strict-type-predicates */
    if (typeof currencyScale !== 'number' && currencyScale !== undefined) {
      throw new Error('currency scale must be a number if specified.' +
        ' type=' + (typeof currencyScale) +
        ' value=' + currencyScale)
    }

    this._maxPacketAmount = new BigNumber(opts.maxPacketAmount || 'Infinity')
    this._currencyScale = (typeof currencyScale === 'number') ? currencyScale : 6
    this._xrpServer = opts.xrpServer
    this._secret = opts.secret
    this._address = opts.address
    this._api = new RippleAPI({ server: this._xrpServer })
    this._watcher = new ChannelWatcher(10 * 60 * 1000, this._api)
    this._bandwidth = opts.maxBalance || opts.bandwidth || '0' // TODO: deprecate _bandwidth
    this._claimInterval = opts.claimInterval || util.DEFAULT_CLAIM_INTERVAL
    this._store = new StoreWrapper(opts._store)
    this._txSubmitter = createSubmitter(this._api, this._address, this._secret)
    this._maxFeePercent = opts.maxFeePercent || '0.01'

    this._channelToAccount = new Map()
    this._accounts = new Map()

    this._watcher.on('channelClose', async (channelId: string, paychan: Paychan) => {
      try {
        await this._channelClose(channelId)
      } catch (e) {
        console.error('ERROR: failed to close channel. channel=' + channelId +
          ' error=' + e.stack)
      }
    })

    this._log = opts.log || createLogger(DEBUG_NAMESPACE)
    this._log.trace = this._log.trace || debug(DEBUG_NAMESPACE + ':trace')
  }

  xrpToBase (amount: BigNumber.Value) {
    return new BigNumber(amount)
      .times(Math.pow(10, this._currencyScale))
      .toString()
  }

  baseToXrp (amount: BigNumber.Value) {
    return new BigNumber(amount)
      .div(Math.pow(10, this._currencyScale))
      .toFixed(6, BigNumber.ROUND_UP)
  }

  sendTransfer () {
    this._log.debug('send transfer no-op')
  }

  _validatePaychanDetails (paychan: Paychan) {
    const settleDelay = paychan.settleDelay
    if (settleDelay < util.MIN_SETTLE_DELAY) {
      this._log.warn(`incoming payment channel has a too low settle delay of ${settleDelay.toString()}` +
        ` seconds. Minimum settle delay is ${util.MIN_SETTLE_DELAY} seconds.`)
      throw new Error('settle delay of incoming payment channel too low')
    }

    if (paychan.cancelAfter) {
      this._log.warn('got incoming payment channel with cancelAfter')
      throw new Error('channel must not have a cancelAfter')
    }

    if (paychan.expiration) {
      this._log.warn('got incoming payment channel with expiration')
      throw new Error('channel must not be in the process of closing')
    }

    if (paychan.destination !== this._address) {
      this._log.warn('incoming channel destination is not our address: ' +
        paychan.destination)
      throw new Error('Channel destination address wrong')
    }
  }

  _getAccount (from: string) {
    const accountName = ilpAddressToAccount(this._prefix, from)
    let account = this._accounts.get(accountName)

    if (!account) {
      account = new Account({
        account: accountName,
        store: this._store,
        api: this._api,
        currencyScale: this._currencyScale,
        log: this._log
      })
      this._accounts.set(accountName, account)
    }

    return account
  }

  _extraInfo (account: Account) {
    const info: ExtraInfo = {
      address: this._address,
      account: this._prefix + account.getAccount(),
      currencyScale: this._currencyScale
    }

    if (account.getState() > ReadyState.PREPARING_CHANNEL) {
      info.channel = account.getChannel()
    }

    if (account.isReady()) {
      info.clientChannel = account.getClientChannel()
    }

    return info
  }

  async _channelClaim (account: Account, close: boolean = false) {
    this._log.trace('creating claim for claim.' +
      ' account=' + account.getAccount() +
      ' channel=' + account.getChannel() +
      ' close=' + close)

    const channel = account.getChannel()
    if (!channel) {
      throw new Error('no channel exists. ' +
        'account=' + account.getAccount())
    }

    const claim = account.getIncomingClaim()
    const publicKey = account.getPaychan().publicKey

    this._log.trace('creating claim tx. account=' + account.getAccount())

    try {
      this._log.trace('querying to make sure a claim is reasonable')
      const xrpClaimAmount = this.baseToXrp(claim.amount.toString())
      const paychan = await this._api.getPaymentChannel(channel)

      if (new BigNumber(paychan.balance).gte(xrpClaimAmount)) {
        const baseBalance = this.xrpToBase(paychan.balance)
        account.setLastClaimedAmount(baseBalance)
        this._log.trace('claim was lower than channel balance.' +
          ' balance=' + baseBalance +
          ' claim=' + claim.amount.toString())
        return
      }

      if (!claim.signature) {
        throw new Error('claim has no signature')
      }

      await this._txSubmitter.submit('preparePaymentChannelClaim', {
        balance: xrpClaimAmount,
        signature: claim.signature.toUpperCase(),
        publicKey,
        close,
        channel
      })
    } catch (err) {
      throw new Error('Error submitting claim. err=' + err)
    }
  }

  async _channelClose (channelId: string) {
    const account = this._channelToAccount.get(channelId)
    if (!account) {
      throw new Error('cannot close channel of nonexistant account. ' +
        'channelId=' + channelId)
    }

    // disable the account once the channel is closing
    account.block(true, 'channel is closing/closed. channelId=' + channelId)
    await this._channelClaim(account, true)
  }

  async _preConnect () {
    await this._api.connect()
    await this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })
  }

  // TODO: also implement cleanup logic
  async _connect (address: string, btpData: BtpData) {
    const { requestId, data } = btpData
    const account = this._getAccount(address)

    if (account.getState() === ReadyState.INITIAL) {
      await account.connect()
    }

    if (account.isBlocked()) {
      throw new Error('cannot connect to blocked account. ' +
        'reconfigure your uplink to connect with a new payment channel.' +
        ' reason=' + account.getBlockReason())
    }

    if (account.getState() > ReadyState.PREPARING_CHANNEL) {
      try {
        this._validatePaychanDetails(account.getPaychan())
        this._channelToAccount.set(account.getChannel(), account)
        await this._watcher.watch(account.getChannel())
        await this._registerAutoClaim(account)
      } catch (e) {
        this._log.debug('deleting channel because of failed validate.' +
          ' account=' + account.getAccount() +
          ' channel=' + account.getChannel() +
          ' error=', e)
        try {
          await this._channelClaim(account)
          account.deleteChannel()
        } catch (err) {
          this._log.error('could not delete channel. error=', err)
        }
        this._log.trace('blocking account. account=' + account.getAccount())
        account.block(true, 'failed to validate channel.' +
          ' channelId=' + account.getChannel() +
          ' error=' + e.message)
      }
    }

    return null
  }

  async _fundOutgoingChannel (account: Account, primary: Protocol): Promise<string> {
    if (account.getState() === ReadyState.READY) {
      this._log.warn('outgoing channel already exists')
      return account.getClientChannel()
    } else if (account.getState() !== ReadyState.ESTABLISHING_CLIENT_CHANNEL) {
      throw new Error('account must be in ESTABLISHING_CLIENT_CHANNEL state to create client channel.' +
        ' state=' + account.getStateString())
    }

    // lock the account's client channel field so a second call to this won't
    // overwrite or race
    account.prepareClientChannel()

    let clientChannelId
    let clientPaychan

    try {
      const outgoingAccount = primary.data.toString()

      this._log.trace('creating outgoing channel fund transaction')
      const keyPairSeed = util.hmac(this._secret, CHANNEL_KEYS + account.getAccount())
      const keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)
      const txTag = util.randomTag()

      const ev = await this._txSubmitter.submit('preparePaymentChannelCreate', {
        amount: util.dropsToXrp(OUTGOING_CHANNEL_DEFAULT_AMOUNT),
        destination: outgoingAccount,
        settleDelay: util.MIN_SETTLE_DELAY,
        publicKey: 'ED' + Buffer.from(keyPair.publicKey).toString('hex').toUpperCase(),
        sourceTag: txTag
      })

      clientChannelId = util.computeChannelId(
        ev.transaction.Account,
        ev.transaction.Destination,
        ev.transaction.Sequence)

      this._log.trace('created outgoing channel. channel=', clientChannelId)
      account.setOutgoingBalance('0')

      clientPaychan = await this._api.getPaymentChannel(clientChannelId) as Paychan
    } catch (e) {
      // relinquish lock on the client channel field
      account.resetClientChannel()
      throw e
    }

    account.setClientChannel(clientChannelId, clientPaychan)
    return clientChannelId
  }

  async _handleCustomData (from: string, message: BtpData) {
    const account = this._getAccount(from)
    const protocols = message.data.protocolData
    if (!protocols.length) return undefined

    const getLastClaim = protocols.find((p: Protocol) => p.protocolName === 'last_claim')
    const fundChannel = protocols.find((p: Protocol) => p.protocolName === 'fund_channel')
    const channelProtocol = protocols.find((p: Protocol) => p.protocolName === 'channel')
    const channelSignatureProtocol = protocols.find((p: Protocol) => p.protocolName === 'channel_signature')
    const ilp = protocols.find((p: Protocol) => p.protocolName === 'ilp')
    const info = protocols.find((p: Protocol) => p.protocolName === 'info')

    // TODO: STATE ASSERTION HERE
    if (getLastClaim) {
      this._log.trace('got request for last claim. claim=', account.getIncomingClaim())
      return [{
        protocolName: 'last_claim',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(account.getIncomingClaim()))
      }]
    }

    if (info) {
      this._log.trace('got info request')
      return [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(this._extraInfo(account)))
      }]
    }

    if (channelProtocol) {
      // TODO: should this be allowed so long as the channel exists already or is being established?
      if (!account.isReady() && account.getState() !== ReadyState.ESTABLISHING_CHANNEL) {
        throw new Error('channel protocol can only be used in READY and ESTABLISHING_CHANNEL states.' +
          ' state=' + account.getStateString())
      }

      this._log.trace('got message for incoming channel. account=', account.getAccount())
      const channel = channelProtocol.data
        .toString('hex')
        .toUpperCase()

      if (!channelSignatureProtocol) {
        throw new Error(`got channel without signature of channel ownership.`)
      }

      if (account.getState() > ReadyState.PREPARING_CHANNEL) {
        if (account.getChannel() !== channel) {
          throw new Error(`there is already an existing channel on this account
            and it doesn't match the 'channel' protocolData`)
        } else {
          // if we already have a channel, that means we should just reload the details
          const paychan = await this._api.getPaymentChannel(channel) as Paychan
          account.reloadChannel(channel, paychan)
          // don't return here because the fund_channel protocol may still need to be processed
        }
      } else {
        // lock to make sure we don't have this going two times
        account.prepareChannel()

        let paychan

        try {
          // Because this reloads channel details even if the channel exists,
          // we can use it to refresh the channel details after extra funds are
          // added
          paychan = await this._api.getPaymentChannel(channel) as Paychan

          // TODO: factor reverse-channel lookup into other class?
          await this._store.load('channel:' + channel)
          const accountForChannel = this._store.get('channel:' + channel)
          if (accountForChannel && account.getAccount() !== accountForChannel) {
            throw new Error(`this channel has already been associated with a ` +
              `different account. account=${account.getAccount()} associated=${accountForChannel}`)
          }

          const fullAccount = this._prefix + account.getAccount()
          const encodedChannelProof = util.encodeChannelProof(channel, fullAccount)
          const isValid = nacl.sign.detached.verify(
            encodedChannelProof,
            channelSignatureProtocol.data,
            Buffer.from(paychan.publicKey.substring(2), 'hex')
          )
          if (!isValid) {
            throw new Error(`invalid signature for proving channel ownership. ` +
              `account=${account.getAccount()} channelId=${channel}`)
          }

          // TODO: fix the ripple-lib FormattedPaymentChannel type to be compatible
          this._validatePaychanDetails(paychan)
        } catch (e) {

          // if we failed to load or validate the channel, then we need to reset the state
          // of this account to 'ESTABLISHING_CHANNEL'
          account.resetChannel()
          throw e
        }

        this._channelToAccount.set(channel, account)
        this._store.set('channel:' + channel, account.getAccount())
        await account.setChannel(channel, paychan)

        await this._watcher.watch(channel)
        await this._registerAutoClaim(account)
        this._log.trace('registered payment channel. account=', account.getAccount())
      }
    }

    if (fundChannel) {
      if (account.getState() !== ReadyState.ESTABLISHING_CLIENT_CHANNEL) {
        throw new Error('fund protocol can only be used in ESTABLISHING_CLIENT_CHANNEL state.' +
          ' state=' + account.getStateString())
      }

      if (new BigNumber(util.xrpToDrops(account.getPaychan().amount)).lt(MIN_INCOMING_CHANNEL)) {
        this._log.debug('denied outgoing paychan request; not enough has been escrowed')
        throw new Error('not enough has been escrowed in channel; must put ' +
          MIN_INCOMING_CHANNEL + ' drops on hold')
      }

      this._log.info('an outgoing paychan has been authorized for ', account.getAccount(), '; establishing')
      const clientChannelId = await this._fundOutgoingChannel(account, fundChannel)
      return [{
        protocolName: 'fund_channel',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from(clientChannelId, 'hex')
      }]
    }

    // in the case of an ilp message, we behave as a connector
    if (ilp) {
      try {
        if (ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
          this._handleIncomingPrepare(account, ilp.data)
        }

        // TODO: don't do this, use connector only instead
        if (ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE && IlpPacket.deserializeIlpPrepare(ilp.data).destination === 'peer.config') {
          return [{
            protocolName: 'ilp',
            contentType: BtpPacket.MIME_APPLICATION_OCTET_STRING,
            data: IlpPacket.serializeIlpFulfill({
              fulfillment: Buffer.alloc(32),
              data: ILDCP.serializeIldcpResponse({
                clientAddress: this._prefix + account.getAccount(),
                assetCode: ASSET_CODE,
                assetScale: ASSET_SCALE
              })
            })
          }]
        }

        let response = await Promise.race([
          this._dataHandler(ilp.data),
          this._expireData(account, ilp.data)
        ])

        if (ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
          if (response[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
            this._rejectIncomingTransfer(account, ilp.data)
          } else if (response[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
            // TODO: should await, or no?
            const { amount } = IlpPacket.deserializeIlpPrepare(ilp.data)
            if (amount !== '0' && this._moneyHandler) this._moneyHandler(amount)
          }
        }

        return this.ilpAndCustomToProtocolData({ ilp: response })
      } catch (e) {
        return this.ilpAndCustomToProtocolData({ ilp: IlpPacket.errorToReject(this._prefix, e) })
      }
    }

    return []
  }

  async _isClaimProfitable (account: Account) {
    const lastClaimedAmount = account.getLastClaimedAmount()
    const amount = account.getIncomingClaim().amount
    const fee = new BigNumber(this.xrpToBase(await this._api.getFee()))
    const income = new BigNumber(amount).minus(lastClaimedAmount)

    this._log.trace('calculating auto-claim. account=' + account.getAccount(), 'amount=' + amount,
      'lastClaimedAmount=' + lastClaimedAmount, 'fee=' + fee)

    return income.isGreaterThan(0) && fee.dividedBy(income).lte(this._maxFeePercent)
  }

  async _autoClaim (account: Account) {
    if (await this._isClaimProfitable(account)) {
      const amount = account.getIncomingClaim().amount
      this._log.trace('starting automatic claim. amount=' + amount + ' account=' + account.getAccount())
      account.setLastClaimedAmount(amount)
      try {
        await this._channelClaim(account)
        this._log.trace('claimed funds. account=' + account.getAccount())
      } catch (err) {
        this._log.warn('WARNING. Error on claim submission: ', err)
      }
    }
  }

  async _registerAutoClaim (account: Account) {
    if (account.getClaimIntervalId()) return

    this._log.trace('registering auto-claim. interval=' + this._claimInterval,
      'account=' + account.getAccount())

    account.setClaimIntervalId(setInterval(
      this._autoClaim.bind(this, account),
      this._claimInterval))
  }

  async _expireData (account: Account, ilpData: Buffer) {
    const isPrepare = ilpData[0] === IlpPacket.Type.TYPE_ILP_PREPARE
    const expiresAt = isPrepare
      ? IlpPacket.deserializeIlpPrepare(ilpData).expiresAt
      : new Date(Date.now() + DEFAULT_TIMEOUT) // TODO: other timeout as default?

    await new Promise((resolve) => setTimeout(resolve, expiresAt.getTime() - Date.now()))
    return isPrepare
      ? IlpPacket.serializeIlpReject({
        code: 'R00',
        triggeredBy: this._prefix, // TODO: is that right?
        message: 'expired at ' + new Date().toISOString(),
        data: Buffer.from('')
      })
      : IlpPacket.serializeIlpError({
        code: 'R00',
        name: 'Transfer Timed Out',
        triggeredBy: this._prefix + account.getAccount(),
        forwardedBy: [],
        triggeredAt: new Date(),
        data: JSON.stringify({
          message: `request timed out after ${DEFAULT_TIMEOUT} ms`
        })
      })
  }

  _handleIncomingPrepare (account: Account, ilpData: Buffer) {
    const { amount } = IlpPacket.deserializeIlpPrepare(ilpData)

    if (!account.isReady()) {
      throw new Errors.UnreachableError('ilp packets will only be forwarded in READY state.' +
        ' state=' + account.getStateString())
    }

    if (this._maxPacketAmount.isLessThan(amount)) {
      throw new Errors.AmountTooLargeError('Packet size is too large.', {
        receivedAmount: amount,
        maximumAmount: this._maxPacketAmount.toString()
      })
    }

    const lastValue = account.getIncomingClaim().amount
    const prepared = account.getBalance()
    const newPrepared = prepared.plus(amount)
    const unsecured = newPrepared.minus(lastValue)
    this._log.trace(unsecured.toString(), 'unsecured; last claim is',
      lastValue.toString(), 'prepared amount', amount, 'newPrepared',
      newPrepared.toString(), 'prepared', prepared.toString())

    if (unsecured.gt(this._bandwidth)) {
      throw new Errors.InsufficientLiquidityError('Insufficient bandwidth, used: ' +
        unsecured + ' max: ' +
        this._bandwidth)
    }

    if (newPrepared.gt(util.xrpToDrops(account.getPaychan().amount))) {
      throw new Errors.InsufficientLiquidityError('Insufficient funds, have: ' +
        util.xrpToDrops(account.getPaychan().amount) +
        ' need: ' + newPrepared.toString())
    }

    account.setBalance(newPrepared.toString())
    this._log.trace(`account ${account.getAccount()} debited ${amount} units, new balance ${newPrepared.toString()}`)
  }

  _rejectIncomingTransfer (account: Account, ilpData: Buffer) {
    const { amount } = IlpPacket.deserializeIlpPrepare(ilpData)
    const prepared = account.getBalance()
    const newPrepared = prepared.minus(amount)

    account.setBalance(newPrepared.toString())
    this._log.trace(`account ${account.getAccount()} roll back ${amount} units, new balance ${newPrepared.toString()}`)
  }

  _sendPrepare (destination: string, parsedPacket: IlpPacket.IlpPacket) {
    const account = this._getAccount(destination)
    if (!account.isReady()) {
      throw new Errors.UnreachableError('account must be in READY state to receive packets.' +
        ' state=' + account.getStateString())
    }
  }

  _handlePrepareResponse (destination: string, parsedResponse: IlpPacket.IlpPacket, preparePacket: IlpPacket.IlpPacket) {
    this._log.trace('got prepare response', parsedResponse)

      if (preparePacket.data.amount === '0') {
        this._log.trace('validated fulfillment for zero-amount packet, not settling.')
        return
      }

      // send off a transfer in the background to settle
      this._log.trace('validated fulfillment. paying settlement.')
      util._requestId()
        .then((requestId: number) => {
          let protocolData
          let amount

          try {
            const owed = this._getAmountOwed(destination)
            amount = owed.plus(preparePacket.data.amount).toString()
            protocolData = this._sendMoneyToAccount(
              amount,
              destination)
            this._decreaseAmountOwed(owed.toString(), destination)
          } catch (e) {
            this._increaseAmountOwed(preparePacket.data.amount, destination)
            throw new Error('failed to create valid claim.' +
              ' error=' + e.message)
          }

          return this._call(destination, {
            type: BtpPacket.TYPE_TRANSFER,
            requestId,
            data: {
              amount,
              protocolData
            }
          })
        })
        .catch((e: Error) => {
          this._log.error(`failed to pay account.
            destination=${destination}
            error=${e && e.stack}`)
        })
    } else if (parsedResponse.type === IlpPacket.Type.TYPE_ILP_REJECT) {
      if (parsedResponse.data.code === 'T04') {
        const owed = this._getAmountOwed(destination)
        this._log.trace('sending settlement on T04 to pay owed balance.' +
          ' destination=' + destination +
          ' owed=' + owed.toString())

        util._requestId()
          .then((requestId: number) => {
            const protocolData = this._sendMoneyToAccount(owed.toString(), destination)
            this._decreaseAmountOwed(owed.toString(), destination)

            return this._call(destination, {
              type: BtpPacket.TYPE_TRANSFER,
              requestId,
              data: {
                amount: owed.toString(),
                protocolData
              }
            })
          })
          .catch((e: Error) => {
            this._log.error('failed to settle after T04.' +
              ` destination=${destination}` +
              ` owed=${owed.toString()}` +
              ` error=${e && e.stack}`)
          })
      }
    }
  }

  _getAmountOwed (to: string) {
    const account = this._getAccount(to)
    return account.getOwedBalance()
  }

  _increaseAmountOwed (amount: string, to: string) {
    const account = this._getAccount(to)
    const owed = account.getOwedBalance()
    const newOwed = owed.plus(amount)
    account.setOwedBalance(newOwed.toString())
  }

  _decreaseAmountOwed (amount: string, to: string) {
    const account = this._getAccount(to)
    const owed = account.getOwedBalance()
    const newOwed = owed.minus(amount)
    account.setOwedBalance(newOwed.toString())
  }

  async sendMoney () {
    // NO-OP
  }

  _sendMoneyToAccount (transferAmount: string, to: string) {
    const account = this._getAccount(to)
    if (!account.isReady()) {
      this._log.error('tried to send settlement to account which is not connected.' +
        ' account=' + account.getAccount() +
        ' state=' + account.getStateString() +
        ' transferAmount=' + transferAmount)
      throw new Error('account is not initialized. account=' + account.getAccount())
    }

    const currentBalance = account.getOutgoingBalance()
    const newBalance = currentBalance.plus(transferAmount)

    // sign a claim
    const clientChannel = account.getClientChannel()
    if (!clientChannel) {
      throw new Error('no client channel exists')
    }

    const clientPaychan = account.getClientPaychan()
    if (!clientPaychan) {
      throw new Error('no client channel details have been loaded')
    }

    const newDropBalance = util.xrpToDrops(this.baseToXrp(newBalance))
    const encodedClaim = util.encodeClaim(newDropBalance.toString(), clientChannel)
    const keyPairSeed = util.hmac(this._secret, CHANNEL_KEYS + account.getAccount())
    const keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)
    const signature = nacl.sign.detached(encodedClaim, keyPair.secretKey)

    this._log.trace(`signing outgoing claim for ${newDropBalance.toString()} drops on ` +
      `channel ${clientChannel}`)

    const aboveThreshold = new BigNumber(util
      .xrpToDrops(clientPaychan.amount))
      .minus(OUTGOING_CHANNEL_DEFAULT_AMOUNT / 2)
      .lt(newDropBalance.toString())

    // if the claim we're signing is for more than the channel's max balance
    // minus half the minimum balance, add some funds
    if (!account.isFunding() && aboveThreshold) {
      this._log.info('adding funds to channel. account=', account.getAccount())
      account.setFunding(true)
      util.fundChannel({
        api: this._api,
        channel: clientChannel,
        address: this._address,
        secret: this._secret,
        // TODO: configurable fund amount?
        amount: OUTGOING_CHANNEL_DEFAULT_AMOUNT
      })
        .then(async () => {
          // reload channel details for the channel we just added funds to
          const clientPaychan = await this._api.getPaymentChannel(clientChannel) as Paychan
          account.reloadClientChannel(clientChannel, clientPaychan)

          account.setFunding(false)
          this._log.trace('completed fund tx. account=', account.getAccount())
          await this._call(to, {
            type: BtpPacket.TYPE_MESSAGE,
            requestId: await util._requestId(),
            data: { protocolData: [{
              protocolName: 'channel',
              contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
              data: Buffer.from(clientChannel, 'hex')
            }] }
          })
        })
        .catch((e: Error) => {
          this._log.error('funding tx/notify failed:', e)
          account.setFunding(false)
        })
    }

    const aboveCapacity = new BigNumber(util
      .xrpToDrops(clientPaychan.amount))
      .lt(newDropBalance.toString())

    if (aboveCapacity) {
      throw new Error('channel does not have enough capacity to process claim.' +
        ' claimAmount=' + newDropBalance.toString() +
        ' clientPaychan.amount=' + util.xrpToDrops(clientPaychan.amount))
    }

    account.setOutgoingBalance(newBalance.toString())
    this._log.trace(`account ${account.getAccount()} added ${transferAmount} units, new balance ${newBalance}`)

    return [{
      protocolName: 'claim',
      contentType: 2,
      data: Buffer.from(JSON.stringify({
        amount: newBalance.toString(),
        signature: Buffer.from(signature).toString('hex')
      }))
    }]
  }

  _handleClaim (account: Account, claim: Claim) {
    let valid = false

    // TODO: if the channel somehow is null, make sure this behaves OK
    const { amount, signature } = claim
    if (!signature) {
      throw new Error('signature must be provided on claim')
    }

    const dropAmount = util.xrpToDrops(this.baseToXrp(amount))
    const encodedClaim = util.encodeClaim(dropAmount, account.getChannel())
    this._log.trace('handling claim. account=' + account.getAccount(), 'amount=' + dropAmount)

    try {
      valid = nacl.sign.detached.verify(
        encodedClaim,
        Buffer.from(signature, 'hex'),
        Buffer.from(account.getPaychan().publicKey.substring(2), 'hex')
      )
    } catch (err) {
      this._log.debug('verifying signature failed:', err.message)
    }

    // TODO: better reconciliation if claims are invalid
    if (!valid) {
      this._log.error(`got invalid claim signature ${signature} for amount ${dropAmount} drops`)
      /* throw new Error('got invalid claim signature ' +
        signature + ' for amount ' + amount + ' drops') */
      throw new Error('Invalid claim: invalid signature')
    }

    // validate claim against balance
    const channelBalance = util.xrpToDrops(account.getPaychan().amount)
    this._log.trace('got channel balance. balance=' + channelBalance)
    if (new BigNumber(dropAmount).gt(channelBalance)) {
      const message = 'got claim for amount higher than channel balance. amount: ' + dropAmount + ', incoming channel balance: ' + channelBalance
      this._log.error(message)
      // throw new Error(message)
      throw new Error('Invalid claim: claim amount (' + dropAmount + ') exceeds channel balance (' + channelBalance + ')')
    }

    const lastValue = new BigNumber(account.getIncomingClaim().amount)
    this._log.trace('got last value. value=' + lastValue.toString(), 'signature=' + account.getIncomingClaim().signature)
    if (lastValue.lt(amount)) {
      this._log.trace('set new claim for amount', amount)
      account.setIncomingClaim(claim)
    } else if (lastValue.eq(amount)) {
      this._log.trace(`got claim for same amount as before. lastValue=${lastValue}, amount=${amount} (this is not necessarily a problem, but may represent an error on the client's side)`)
    } else {
      this._log.trace('last value is less than amount. lastValue=' + lastValue.toString(),
        'amount=' + amount)
    }
  }

  _handleMoney (from: string, btpData: BtpData) {
    const account = this._getAccount(from)
    if (account.getState() < ReadyState.LOADING_CLIENT_CHANNEL) {
      this._log.error('got claim from account which is not fully connected.' +
        ' account=' + account.getAccount() +
        ' state=' + account.getStateString())
      throw new Error('account is not initialized; claim cannot be accepted.' +
        ' account=' + account.getAccount())
    }

    this._log.trace('handling money. account=' + account.getAccount())

    // TODO: match the transfer amount
    const protocolData = btpData.data.protocolData
    if (!protocolData.length) {
      throw new Error('got transfer with empty protocolData.' +
        ' requestId=' + btpData.requestId)
    }

    const [ jsonClaim ] = btpData.data.protocolData
      .filter((p: Protocol) => p.protocolName === 'claim')
    if (!jsonClaim || !jsonClaim.data.length) {
      this._log.debug('no claim was supplied on transfer')
      throw new Error('No claim was supplied on transfer')
    }

    const claim = JSON.parse(jsonClaim.data.toString())
    this._handleClaim(account, claim)
  }

  async _disconnect () {
    this._log.info('disconnecting accounts and api')
    for (const account of this._accounts.values()) {
      account.disconnect()
    }
    this._api.connection.removeAllListeners()
    await this._api.disconnect()
    await this._store.close()
  }
}
