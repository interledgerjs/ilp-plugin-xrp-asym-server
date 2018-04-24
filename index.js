'use strict'

const crypto = require('crypto')
const IlpPacket = require('ilp-packet')
const { Errors } = IlpPacket
const nacl = require('tweetnacl')
const { RippleAPI } = require('ripple-lib')
const BtpPacket = require('btp-packet')
const BigNumber = require('bignumber.js')
const debug = require('debug')('ilp-plugin-xrp-server')
const MiniAccountsPlugin = require('ilp-plugin-mini-accounts')
const Ildcp = require('ilp-protocol-ildcp')
const OUTGOING_CHANNEL_DEFAULT_AMOUNT = Math.pow(10, 6) // 1 XRP
const MIN_INCOMING_CHANNEL = 10000000
const ASSET_SCALE = 6
const ASSET_CODE = 'XRP'

const CHANNEL_KEYS = 'ilp-plugin-multi-xrp-paychan-channel-keys'
const DEFAULT_TIMEOUT = 30000 // TODO: should this be something else?
const StoreWrapper = require('./src/store-wrapper')
const Account = require('./src/account')
const {
  createSubmitter,
  util,
  ChannelWatcher
} = require('ilp-plugin-xrp-paychan-shared')

function ilpAddressToAccount (prefix, ilpAddress) {
  if (ilpAddress.substr(0, prefix.length) !== prefix) {
    throw new Error('ILP address (' + ilpAddress + ') must start with prefix (' + prefix + ')')
  }

  return ilpAddress.substr(prefix.length).split('.')[0]
}

class Plugin extends MiniAccountsPlugin {
  constructor (opts) {
    super(opts)

    if (opts.assetScale && opts.currencyScale) {
      throw new Error('opts.assetScale is an alias for opts.currencyScale;' +
        'only one must be specified')
    }

    const currencyScale = opts.assetScale || opts.currencyScale

    if (typeof currencyScale !== 'number' && currencyScale !== undefined) {
      throw new Error('currency scale must be a number if specified.' +
        ' type=' + (typeof currencyScale) +
        ' value=' + currencyScale)
    }

    this._currencyScale = (typeof currencyScale === 'number') ? currencyScale : 6
    this._xrpServer = opts.xrpServer
    this._secret = opts.secret
    this._address = opts.address
    this._api = new RippleAPI({ server: this._xrpServer })
    this._watcher = new ChannelWatcher(10 * 60 * 1000, this._api)
    this._bandwidth = opts.maxBalance || opts.bandwidth || 0 // TODO: deprecate _bandwidth
    this._claimInterval = opts.claimInterval || util.DEFAULT_CLAIM_INTERVAL
    this._store = new StoreWrapper(opts._store)
    this._txSubmitter = createSubmitter(this._api, this._address, this._secret)

    this._channelToAccount = new Map()
    this._accounts = new Map()

    this._watcher.on('channelClose', async (channelId, paychan) => {
      try {
        await this._channelClose(channelId)
      } catch (e) {
        console.error('ERROR: failed to close channel. channel=' + channelId +
          ' error=' + e.stack)
      }
    })
  }

  xrpToBase (amount) {
    return new BigNumber(amount)
      .mul(Math.pow(10, this._currencyScale))
      .toString()
  }

  baseToXrp (amount) {
    return new BigNumber(amount)
      .div(Math.pow(10, this._currencyScale))
      .toFixed(6, BigNumber.ROUND_UP)
  }

  sendTransfer () {}

  _validatePaychanDetails (paychan) {
    const settleDelay = paychan.settleDelay
    if (settleDelay < util.MIN_SETTLE_DELAY) {
      debug(`incoming payment channel has a too low settle delay of ${settleDelay.toString()}` +
        ` seconds. Minimum settle delay is ${util.MIN_SETTLE_DELAY} seconds.`)
      throw new Error('settle delay of incoming payment channel too low')
    }

    if (paychan.cancelAfter) {
      debug('got incoming payment channel with cancelAfter')
      throw new Error('channel must not have a cancelAfter')
    }

    if (paychan.expiration) {
      debug('got incoming payment channel with expiration')
      throw new Error('channel must not be in the process of closing')
    }

    if (paychan.destination !== this._address) {
      debug('incoming channel destination is not our address: ' +
        paychan.destination)
      throw new Error('Channel destination address wrong')
    }
  }

  _getAccount (from) {
    const accountName = ilpAddressToAccount(this._prefix, from)
    let account = this._accounts.get(accountName)

    if (!account) {
      account = new Account({
        account: accountName,
        store: this._store,
        api: this._api
      })
      this._accounts.set(accountName, account)
    }

    return account
  }

  _extraInfo (account) {
    return {
      channel: account.getChannel(),
      clientChannel: account.getClientChannel(),
      address: this._address,
      account: this._prefix + account.getAccount(),
      currencyScale: this._currencyScale
    }
  }

  async _channelClaim (account) {
    debug('creating claim for claim. account=' + account.getAccount())
    const channel = account.getChannel()
    const claim = account.getIncomingClaim()
    const publicKey = account.getPaychan().publicKey

    debug('creating claim tx. account=' + account.getAccount())

    try {
      await this._txSubmitter.submit('preparePaymentChannelClaim', {
        balance: util.dropsToXrp(claim.amount.toString()),
        signature: claim.signature.toUpperCase(),
        publicKey,
        channel
      })
    } catch (err) {
      throw new Error('Error submitting claim')
    }
  }

  async _channelClose (channelId, closeAt) {
    const account = this._channelToAccount.get(channelId)

    // disable the account once the channel is closing
    account.block()

    // close our outgoing channel to them
    debug('creating claim for closure')
    const balance = account.getBalance()
    const dropBalance = util.xrpToDrops(this.baseToXrp(balance))
    const channel = account.getClientChannel()
    const encodedClaim = util.encodeClaim(dropBalance.toString(), channel)
    const keyPairSeed = util.hmac(this._secret, CHANNEL_KEYS + account.getAccount())
    const keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)
    const signature = nacl.sign.detached(encodedClaim, keyPair.secretKey)

    debug('creating close tx')
    await this._txSubmitter.submit('preparePaymentChannelClaim', {
      balance: this.baseToXrp(balance),
      signature: signature.toString('hex').toUpperCase(),
      publicKey: 'ED' + Buffer.from(keyPair.publicKey).toString('hex').toUpperCase(),
      channel,
      close: true
    })
  }

  async _preConnect () {
    await this._api.connect()
    await this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })
  }

  // TODO: also implement cleanup logic
  async _connect (address, { requestId, data }) {
    const account = this._getAccount(address)
    await account.connect()

    const existingChannel = account.getChannel()
    if (existingChannel) {
      try {
        this._validatePaychanDetails(account.getPaychan())
        this._channelToAccount.set(existingChannel, account)
        await this._registerAutoClaim(account)
      } catch (e) {
        debug('deleting channel because of failed validate. error=', e)
        try {
          await this._channelClaim(account)
          account.deleteChannel()
        } catch (err) {
          debug('could not delete channel. error=', err)
          // should the account be blocked?
        }
      }
    }

    return null
  }

  async _fundOutgoingChannel (account, primary) {
    if (account.getClientChannel()) {
      debug('outgoing channel already exists')
      return account.getClientPaychan()
    }

    // TODO: some way to do this via account class
    this._store.setCache(account + ':client_channel', true)

    const outgoingAccount = primary.data.toString()

    debug('creating outgoing channel fund transaction')
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

    const clientChannelId = util.computeChannelId(
      ev.transaction.Account,
      ev.transaction.Destination,
      ev.transaction.Sequence)

    debug('created outgoing channel. channel=', clientChannelId)
    const clientPaychan = await this._api.getPaymentChannel(clientChannelId)
    account.setOutgoingBalance('0')
    account.setClientChannel(clientChannelId, clientPaychan)

    return clientChannelId
  }

  async _handleCustomData (from, message) {
    const account = this._getAccount(from)
    const protocols = message.data.protocolData
    if (!protocols.length) return

    const getLastClaim = protocols.filter(p => p.protocolName === 'last_claim')[0]
    const fundChannel = protocols.filter(p => p.protocolName === 'fund_channel')[0]
    const channelProtocol = protocols.filter(p => p.protocolName === 'channel')[0]
    const channelSignatureProtocol = protocols.filter(p => p.protocolName === 'channel_signature')[0]
    const ilp = protocols.filter(p => p.protocolName === 'ilp')[0]
    const info = protocols.filter(p => p.protocolName === 'info')[0]

    if (getLastClaim) {
      debug('got request for last claim. claim=', account.getIncomingClaim())
      return [{
        protocolName: 'last_claim',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(account.getIncomingClaim()))
      }]
    }

    if (info) {
      debug('got info request')
      return [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(this._extraInfo(account)))
      }]
    }

    if (channelProtocol) {
      debug('got message for incoming channel. account=', account.getAccount())
      const channel = channelProtocol.data
        .toString('hex')
        .toUpperCase()

      if (!channelSignatureProtocol) {
        throw new Error(`got channel without signature of channel ownership.`)
      }

      const existingChannel = account.getChannel()
      if (existingChannel && existingChannel !== channel) {
        throw new Error(`there is already an existing channel on this account
          and it doesn't match the 'channel' protocolData`)
      }

      // Because this reloads channel details even if the channel exists,
      // we can use it to refresh the channel details after extra funds are
      // added
      const paychan = await this._api.getPaymentChannel(channel)

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

      this._validatePaychanDetails(paychan)
      this._channelToAccount.set(channel, account)
      this._store.set('channel:' + channel, account.getAccount())
      account.setChannel(channel, paychan)

      await this._watcher.watch(channel)
      await this._registerAutoClaim(account)
      debug('registered payment channel. account=', account.getAccount())
    }

    if (fundChannel) {
      if (new BigNumber(util.xrpToDrops(account.getPaychan().amount)).lt(MIN_INCOMING_CHANNEL)) {
        debug('denied outgoing paychan request; not enough has been escrowed')
        throw new Error('not enough has been escrowed in channel; must put ' +
          MIN_INCOMING_CHANNEL + ' drops on hold')
      }

      debug('an outgoing paychan has been authorized for ', account.getAccount(), '; establishing')
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
              data: Ildcp.serializeIldcpResponse({
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

  async _autoClaim (account) {
    const lastClaimedAmount = account.getLastClaimedAmount()
    const amount = this.baseToXrp(account.getIncomingClaim().amount)
    const fee = await this._api.getFee()

    debug('auto-claiming. account=' + account.getAccount(), 'amount=' + amount,
      'lastClaimedAmount=' + lastClaimedAmount, 'fee=' + fee)
    if (new BigNumber(lastClaimedAmount).plus(fee).lt(amount)) {
      debug('starting automatic claim. amount=' + amount + ' account=' + account.getAccount())
      account.setLastClaimedAmount(amount)
      try {
        await this._channelClaim(account)
        debug('claimed funds. account=' + account.getAccount())
      } catch (err) {
        debug('WARNING. Error on claim submission: ', err)
      }
    }
  }

  async _registerAutoClaim (account) {
    if (account.getClaimIntervalId()) return

    debug('registering auto-claim. interval=' + this._claimInterval,
      'account=' + account.getAccount())

    account.setClaimIntervalId(setInterval(
      this._autoClaim.bind(this, account),
      this._claimInterval))
  }

  async _expireData (account, ilpData) {
    const isPrepare = ilpData[0] === IlpPacket.Type.TYPE_ILP_PREPARE
    const expiresAt = isPrepare
      ? IlpPacket.deserializeIlpPrepare(ilpData).expiresAt
      : new Date(Date.now() + DEFAULT_TIMEOUT) // TODO: other timeout as default?

    await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now()))
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

  _handleIncomingPrepare (account, ilpData) {
    const { amount } = IlpPacket.deserializeIlpPrepare(ilpData)

    if (!account.getPaychan()) {
      throw new Errors.UnreachableError(`Incoming traffic won't be accepted until a channel to the connector is established.`)
    }

    if (account.isBlocked()) {
      throw new Errors.UnreachableError('This account has been closed.')
    }

    const lastValue = account.getIncomingClaim().amount
    const prepared = account.getBalance()
    const newPrepared = prepared.plus(amount)
    const unsecured = newPrepared.minus(lastValue)
    debug(unsecured.toString(), 'unsecured; last claim is',
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
    debug(`account ${account.getAccount()} debited ${amount} units, new balance ${newPrepared.toString()}`)
  }

  _rejectIncomingTransfer (account, ilpData) {
    const { amount } = IlpPacket.deserializeIlpPrepare(ilpData)
    const prepared = account.getBalance()
    const newPrepared = prepared.minus(amount)

    account.setBalance(newPrepared.toString())
    debug(`account ${account.getAccount()} roll back ${amount} units, new balance ${newPrepared.toString()}`)
  }

  _sendPrepare (destination, parsedPacket) {
    // TODO: do we need anything here?
  }

  _handlePrepareResponse (destination, parsedResponse, preparePacket) {
    debug('got prepare response', parsedResponse)
    if (parsedResponse.type === IlpPacket.Type.TYPE_ILP_FULFILL) {
      if (!crypto.createHash('sha256')
        .update(parsedResponse.data.fulfillment)
        .digest()
        .equals(preparePacket.data.executionCondition)) {
          // TODO: could this leak data if the fulfillment is wrong in
          // a predictable way?
        throw new Errors.WrongConditionError(`condition and fulfillment don't match.
            condition=${preparePacket.data.executionCondition.toString('hex')}
            fulfillment=${parsedResponse.data.fulfillment.toString('hex')}`)
      }

      // send off a transfer in the background to settle
      debug('validated fulfillment. paying settlement.')
      util._requestId()
        .then((requestId) => {
          return this._call(destination, {
            type: BtpPacket.TYPE_TRANSFER,
            requestId,
            data: {
              amount: preparePacket.data.amount,
              protocolData: this._sendMoneyToAccount(
                preparePacket.data.amount,
                destination)
            }
          })
        })
        .catch((e) => {
          debug(`failed to pay account.
            destination=${destination}
            error=${e && e.stack}`)
        })
    }
  }

  async sendMoney () {
    // NO-OP
  }

  _sendMoneyToAccount (transferAmount, to) {
    const account = this._getAccount(to)
    // TODO: do we need to connect this account?

    const currentBalance = account.getOutgoingBalance()
    const newBalance = currentBalance.plus(transferAmount)
    account.setOutgoingBalance(newBalance.toString())
    debug(`account ${account.getAccount()} added ${transferAmount} units, new balance ${newBalance}`)

    // sign a claim
    const clientChannel = account.getClientChannel()
    const newDropBalance = util.xrpToDrops(this.baseToXrp(newBalance))
    const encodedClaim = util.encodeClaim(newDropBalance.toString(), clientChannel)
    const keyPairSeed = util.hmac(this._secret, CHANNEL_KEYS + account.getAccount())
    const keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)
    const signature = nacl.sign.detached(encodedClaim, keyPair.secretKey)

    debug(`signing outgoing claim for ${newDropBalance.toString()} drops on ` +
      `channel ${clientChannel}`)

    const aboveThreshold = new BigNumber(util
      .xrpToDrops(account.getClientPaychan().amount))
      .minus(OUTGOING_CHANNEL_DEFAULT_AMOUNT / 2)
      .lt(newDropBalance.toString())

    // if the claim we're signing is for more than the channel's max balance
    // minus half the minimum balance, add some funds
    if (!account.isFunding() && aboveThreshold) {
      debug('adding funds to channel. account=', account.getAccount())
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
          await account.setClientChannel(clientChannel) // reloads the channel amount
          account.setFunding(false)
          debug('completed fund tx. account=', account.getAccount())
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
        .catch((e) => {
          debug('funding tx/notify failed:', e)
          account.setFunding(false)
        })
    }

    return [{
      protocolName: 'claim',
      contentType: 2,
      data: Buffer.from(JSON.stringify({
        amount: newBalance.toString(),
        signature: Buffer.from(signature).toString('hex')
      }))
    }]
  }

  _handleClaim (account, claim) {
    let valid = false

    // TODO: if the channel somehow is null, make sure this behaves OK
    const { amount, signature } = claim
    const dropAmount = util.xrpToDrops(this.baseToXrp(amount))
    const encodedClaim = util.encodeClaim(dropAmount, account.getChannel())
    debug('handling claim. account=' + account, 'amount=' + dropAmount)

    try {
      valid = nacl.sign.detached.verify(
        encodedClaim,
        Buffer.from(signature, 'hex'),
        Buffer.from(account.getPaychan().publicKey.substring(2), 'hex')
      )
    } catch (err) {
      debug('verifying signature failed:', err.message)
    }

    // TODO: better reconciliation if claims are invalid
    if (!valid) {
      debug(`got invalid claim signature ${signature} for amount ${dropAmount} drops`)
      /* throw new Error('got invalid claim signature ' +
        signature + ' for amount ' + amount + ' drops') */
      throw new Error('Invalid claim: invalid signature')
    }

    // validate claim against balance
    const channelBalance = util.xrpToDrops(account.getPaychan().amount)
    debug('got channel balance. balance=' + channelBalance)
    if (new BigNumber(dropAmount).gt(channelBalance)) {
      const message = 'got claim for amount higher than channel balance. amount: ' + dropAmount + ', incoming channel balance: ' + channelBalance
      debug(message)
      // throw new Error(message)
      throw new Error('Invalid claim: claim amount (' + dropAmount + ') exceeds channel balance (' + channelBalance + ')')
    }

    const lastValue = new BigNumber(account.getIncomingClaim().amount)
    debug('got last value. value=' + lastValue.toString(), 'signature=' + account.getIncomingClaim.signature)
    if (lastValue.lt(amount)) {
      debug('set new claim for amount', amount)
      account.setIncomingClaim(JSON.stringify(claim))
    } else {
      debug('last value is less than amount. lastValue=' + lastValue.toString(),
        'amount=' + amount)
    }
  }

  _handleMoney (from, btpData) {
    const account = this._getAccount(from)
    debug('handling money. account=' + account)

    // TODO: match the transfer amount
    const protocolData = btpData.data.protocolData
    if (!protocolData.length) {
      throw new Error('got transfer with empty protocolData.' +
        ' requestId=' + btpData.requestId)
    }

    const [ jsonClaim ] = btpData.data.protocolData
      .filter(p => p.protocolName === 'claim')
    if (!jsonClaim || !jsonClaim.data.length) {
      debug('no claim was supplied on transfer')
      throw new Error('No claim was supplied on transfer')
    }

    const claim = JSON.parse(jsonClaim.data.toString())
    this._handleClaim(account, claim)
  }

  async _disconnect () {
    debug('disconnecting accounts and api')
    for (const account of this._accounts.values()) {
      if (!account.getClaimIntervalId()) { clearInterval(account.getClaimIntervalId()) }
    }
    this._api.connection.removeAllListeners()
    await this._api.disconnect()
  }
}

Plugin.version = 2
module.exports = Plugin
