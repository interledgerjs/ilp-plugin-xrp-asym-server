const crypto = require('crypto')
const IlpPacket = require('ilp-packet')
const { Reader, Writer } = require('oer-utils')
const addressCodec = require('ripple-address-codec')
const nacl = require('tweetnacl')
const { RippleAPI } = require('ripple-lib')
const BtpPacket = require('btp-packet')
const BigNumber = require('bignumber.js')
const WebSocket = require('ws')
const assert = require('assert')
const debug = require('debug')('ilp-plugin-xrp-server')
const MiniAccountsPlugin = require('ilp-plugin-mini-accounts')
const base64url = require('base64url')
const bignum = require('bignum')
const OUTGOING_CHANNEL_DEFAULT_AMOUNT = Math.pow(10, 6) // 1 XRP
const MIN_INCOMING_CHANNEL = 10000000
const CHANNEL_KEYS = 'ilp-plugin-multi-xrp-paychan-channel-keys'
const DEFAULT_TIMEOUT = 30000 // TODO: should this be something else?
const StoreWrapper = require('./src/store-wrapper')
const { 
  util,
  ChannelWatcher
} = require('ilp-plugin-xrp-paychan-shared')

function tokenToAccount (token) {
  return base64url(crypto.createHash('sha256').update(token).digest('sha256'))
}

function ilpAddressToAccount (prefix, ilpAddress) {
  if (ilpAddress.substr(0, prefix.length) !== prefix) {
    throw new Error('ILP address (' + ilpAddress + ') must start with prefix (' + prefix + ')')
  }

  return ilpAddress.substr(prefix.length).split('.')[0]
}

class Plugin extends MiniAccountsPlugin {
  constructor (opts) {
    super(opts)

    this._xrpServer = opts.xrpServer
    this._secret = opts.secret
    this._address = opts.address
    this._api = new RippleAPI({ server: this._xrpServer })
    this._watcher = new ChannelWatcher(10 * 60 * 1000, this._api)
    this._bandwidth = opts.bandwidth || 1000
    this._claimInterval = opts.claimInterval || util.DEFAULT_CLAIM_INTERVAL

    this._balances = new StoreWrapper(opts._store)
    this._paychans = new Map()
    this._clientPaychans = new Map()
    this._channelToAccount = new Map()
    this._connections = new Map()
    this._funding = new Map()
    this._lastClaimedAmounts = new Map()
    this._claimIntervalIds = new Map()
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

  _extraInfo (from) {
    const account = ilpAddressToAccount(this._prefix, from)
    const channel = this._balances.get(account + ':channel')
    const clientChannel = this._balances.get(account + ':client_channel')
    const address = this._address
    
    return {
      channel,
      clientChannel,
      address,
      account: from
    }
  }

  async _channelClaim (account) {
    debug('creating claim for claim. account=' + account)
    const balance = this._balances.get(account)
    const channel = this._balances.get(account + ':channel')
    const claim = this._getLastClaim(account)
    const publicKey = this._paychans.get(account).publicKey

    debug('creating claim tx. account=' + account)
    const tx = await this._api.preparePaymentChannelClaim(this._address, {
      balance: util.dropsToXrp(claim.amount.toString()),
      signature: claim.signature.toUpperCase(),
      publicKey,
      channel
    })

    debug('signing claim transaction. account=' + account)
    const signedTx = this._api.sign(tx.txJSON, this._secret)

    debug('submitting claim transaction. tx=', tx, ' account=' + account)
    const {resultCode, resultMessage} = await this._api.submit(signedTx.signedTransaction)
    if (resultCode !== 'tesSUCCESS') {
      console.error('WARNING: Error submitting close: ', resultMessage)
    }
  }

  async _channelClose (channelId, closeAt) {
    const account = channelToAccount.get(channelId) 

    // disable the account once the channel is closing
    this._balances.set(account + ':block')

    // close our outgoing channel to them
    debug('creating claim for closure')
    const balanceKey = account + ':outgoing_balance'
    const balance = this._balances.get(balanceKey)
    const channel = this._balances.get(account + ':client_channel')
    const encodedClaim = util.encodeClaim(balance.toString(), channel)
    const keyPairSeed = util.hmac(this._secret, CHANNEL_KEYS + account)
    const keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)
    const signature = nacl.sign.detached(encodedClaim, keyPair.secretKey)

    debug('creating close tx')
    const tx = await this._api.preparePaymentChannelClaim(this._address, {
      balance: util.dropsToXrp(balance.toString()),
      signature: signature.toString('hex').toUpperCase(),
      publicKey: 'ED' + Buffer.from(keyPair.publicKey).toString('hex').toUpperCase(),
      channel,
      close: true
    })

    debug('signing close transaction')
    const signedTx = this._api.sign(tx.txJSON, this._secret)

    debug('submitting close transaction', tx)
    const {resultCode, resultMessage} = await this._api.submit(signedTx.signedTransaction)
    if (resultCode !== 'tesSUCCESS') {
      console.error('WARNING: Error submitting close: ', resultMessage)
    }
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
    const account = this.ilpAddressToAccount(address)
    const channelKey = account + ':channel'
    await this._balances.load(channelKey)
    const existingChannel = this._balances.get(channelKey)

    await this._balances.load(account)
    await this._balances.load(account + ':claim')
    await this._balances.load(account + ':block')
    await this._balances.load(account + ':client_channel')
    await this._balances.load(account + ':outgoing_balance')
    const existingClientChannel = this._balances.get(account + ':client_channel')

    if (existingChannel) {
      // TODO: DoS vector by requesting paychan on user connect?
      const paychan = await this._api.getPaymentChannel(existingChannel)
      this._validatePaychanDetails(paychan)
      this._paychans.set(account, paychan)
      this._channelToAccount.set(existingChannel, account)
      await this._registerAutoClaim(account)
    }

    if (existingClientChannel) {
      const paychan = await this._api.getPaymentChannel(existingClientChannel)
      this._clientPaychans.set(account, paychan)
    }

    return null
  }

  async _fundOutgoingChannel (account, primary) {
    await this._balances.load(account + ':client_channel')
    await this._balances.load(account + ':outgoing_balance')

    const existing = this._balances.get(account + ':client_channel')
    if (existing) {
      debug('outgoing channel already exists')
      const paychan = await this._api.getPaymentChannel(existing)
      this._clientChannels.set(account, paychan)
      return existing
    }

    this._balances.setCache(account + ':client_channel', true)

    const outgoingAccount = primary.data.toString() 
    // TODO: validate the account

    debug('creating outgoing channel fund transaction')
    const keyPairSeed = util.hmac(this._secret, CHANNEL_KEYS + account)
    const keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)
    const txTag = util.randomTag()
    const tx = await this._api.preparePaymentChannelCreate(this._address, {
      amount: util.dropsToXrp(OUTGOING_CHANNEL_DEFAULT_AMOUNT),
      destination: outgoingAccount,
      settleDelay: util.MIN_SETTLE_DELAY,
      publicKey: 'ED' + Buffer.from(keyPair.publicKey).toString('hex').toUpperCase(),
      sourceTag: txTag
    })

    debug('submitting transaction')
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = await this._api.submit(signedTx.signedTransaction)

    if (result.resultCode !== 'tesSUCCESS') {
      const message = 'Error creating the payment channel: ' + result.resultCode + ' ' + result.resultMessage
      debug(message)
      return
    }

    return new Promise((resolve) => {
      const handleTransaction = async (ev) => {
        if (ev.transaction.SourceTag !== txTag) return
        if (ev.transaction.Account !== this._address) return

        const clientChannelId = util.computeChannelId(
          ev.transaction.Account,
          ev.transaction.Destination,
          ev.transaction.Sequence)

        debug('created outgoing channel. channel=', clientChannelId)
        this._balances.set(account + ':outgoing_balance', '0')
        this._balances.set(account + ':client_channel', clientChannelId)

        const paychan = await this._api.getPaymentChannel(clientChannelId)
        this._clientPaychans.set(account, paychan)

        setImmediate(() => this._api.connection
          .removeListener('transaction', handleTransaction))
        resolve(clientChannelId)
      }

      this._api.connection.on('transaction', handleTransaction)
    })
  }

  async _handleCustomData (from, message) {
    const account = ilpAddressToAccount(this._prefix, from)
    const protocols = message.data.protocolData
    if (!protocols.length) return

    const getLastClaim = protocols.filter(p => p.protocolName === 'last_claim')[0]
    const fundChannel = protocols.filter(p => p.protocolName === 'fund_channel')[0]
    const channelProtocol = protocols.filter(p => p.protocolName === 'channel')[0]
    const channelSignatureProtocol = protocols.filter(p => p.protocolName === 'channel_signature')[0]
    const ilp = protocols.filter(p => p.protocolName === 'ilp')[0]
    const info = protocols.filter(p => p.protocolName === 'info')[0]

    if (getLastClaim) {
      debug('got request for last claim:', this._getLastClaim(account))
      return [{
        protocolName: 'last_claim',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(this._getLastClaim(account)))
      }]
    }

    if (info) {
      debug('got info request')
      return [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify(this._extraInfo(from)))
      }]
    }

    if (channelProtocol) {
      debug('got message for incoming channel on account', account)
      const channel = channelProtocol.data
        .toString('hex')
        .toUpperCase()

      if (!channelSignatureProtocol) {
        throw new Error(`got channel without signature of channel ownership.`)
      }

      const channelKey = account + ':channel'
      const existingChannel = this._balances.get(channelKey)

      if (existingChannel && existingChannel !== channel) {
        throw new Error(`there is already an existing channel on this account
          and it doesn't match the 'channel' protocolData`)
      }

      // Because this reloads channel details even if the channel exists,
      // we can use it to refresh the channel details after extra funds are
      // added
      const paychan = await this._api.getPaymentChannel(channel)

      await this._balances.load('channel:' + channel)
      const accountForChannel = this._balances.get('channel:' + channel)
      if (accountForChannel && channel !== accountForChannel) {
        throw new Error(`this channel has already been associated with a
          different account. account=${account} associated=${accountForChannel}`)
      }

      const encodedChannelProof = util.encodeChannelProof(channel, account)
      nacl.sign.detached.verify(
        encodedChannelProof,
        channelSignatureProtocol.data,
        Buffer.from(paychan.publicKey.substring(2), 'hex')
      )

      this._validatePaychanDetails(paychan)
      this._paychans.set(account, paychan)
      this._channelToAccount.set(channel, account)
      this._balances.set(account + ':channel', channel)
      this._balances.set('channel:' + channel, account)

      await this._registerAutoClaim(account)
      debug('registered payment channel for', account)
    }

    if (fundChannel) {
      const incomingChannel = this._paychans.get(account)

      if (new BigNumber(util.xrpToDrops(incomingChannel.amount)).lessThan(MIN_INCOMING_CHANNEL)) {
        debug('denied outgoing paychan request; not enough has been escrowed')
        throw new Error('not enough has been escrowed in channel; must put ' +
          MIN_INCOMING_CHANNEL + ' drops on hold')
      }

      debug('an outgoing paychan has been authorized for', account, '; establishing')
      const clientChannelId = await this._fundOutgoingChannel(account, fundChannel)

      // TODO: should the channel subprotocol be merged with fund_channel, such that the
      // connector will see that enough funds have been escrowed to them and then they can
      // open a counter-channel?

      return [{
        protocolName: 'fund_channel',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.from(clientChannelId, 'hex')
      }]
    }

    // in the case of an ilp message, we behave as a connector
    if (ilp) {
      if (ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
        this._handleIncomingPrepare(account, ilp.data)
      }

      // TODO: don't do this, use connector only instead
      if (ilp.data[0] === IlpPacket.Type.TYPE_ILP_PREPARE && IlpPacket.deserializeIlpPrepare(ilp.data).destination === 'peer.config') {
        const writer = new Writer()
        const response = this._prefix + account
        writer.writeVarOctetString(Buffer.from(response))

        return [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STRING,
          data: IlpPacket.serializeIlpFulfill({
            fulfillment: Buffer.alloc(32),
            data: writer.getBuffer()
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
          const { amount, destination, data } = IlpPacket.deserializeIlpPrepare(ilp.data)
          if (amount !== '0' && this._moneyHandler) this._moneyHandler(amount)
        }
      }

      return this.ilpAndCustomToProtocolData({ ilp: response })
    }

    return []
  }

  async _registerAutoClaim (account) {
    debug('registering auto-claim. interval=' + this._claimInterval,
      'account=' + account)

    const paychan = this._paychans.get(account)

    // TODO: better cleanup of in-memory fields
    // TODO: will a channel update trigger two concurrent intervals?
    this._lastClaimedAmounts.set(account, util.xrpToDrops(paychan.balance))
    this._claimIntervalIds.set(account, setInterval(async () => {
      const lastClaimedAmount = this._lastClaimedAmounts.get(account)
      const amount = this._getLastClaim(account).amount

      debug('auto-claiming. account=' + account, 'amount=' + amount,
        'lastClaimedAmount=' + lastClaimedAmount)
      if (new BigNumber(lastClaimedAmount).lessThan(amount)) {
        debug('starting automatic claim. amount=' + amount + ' account=' + account)
        this._lastClaimedAmounts.set(account, amount)
        await this._channelClaim(account)
        debug('claimed funds. account=' + account)
      }
    }, this._claimInterval))
  }

  async _expireData (account, ilpData) {
    const isPrepare = ilpData[0] === IlpPacket.Type.TYPE_ILP_PREPARE
    const expiresAt = isPrepare
      ? IlpPacket.deserializeIlpPrepare(ilpData).expiresAt
      : new Date(Date.now() + DEFAULT_TIMEOUT) // TODO: other timeout as default?

    await new Promise((resolve) => setTimeout(resolve, expiresAt - Date.now()))
    return isPrepare
      ? IlpPacket.serializeIlpReject({
          code: 'F00',
          triggeredBy: this._prefix, // TODO: is that right?
          message: 'expired at ' + new Date().toISOString(),
          data: Buffer.from('')
        })
      : IlpPacket.serializeIlpError({
          code: 'F00',
          name: 'Bad Request',
          triggeredBy: this._prefix,
          forwardedBy: [],
          triggeredAt: new Date(),
          data: JSON.stringify({
            message: `request timed out after ${DEFAULT_TIMEOUT} ms`
          })
        })
  }

  _handleIncomingPrepare (account, ilpData) {
    const {
      amount,
      executionCondition,
      expiresAt,
      destination,
      data
    } = IlpPacket.deserializeIlpPrepare(ilpData)

    const paychan = this._paychans.get(account)
    if (!paychan) {
      throw new Error(`Incoming traffic won't be accepted until a channel
        to the connector is established.`)
    }

    if (this._balances.get(account + ':block')) {
      throw new Error('This account has been closed.')
    }

    const lastClaim = this._getLastClaim(account)
    const lastValue = new BigNumber(lastClaim.amount)

    const prepared = new BigNumber(this._balances.get(account) || '0')
    const newPrepared = prepared.add(amount)
    const unsecured = newPrepared.sub(lastValue)
    debug(unsecured.toString(), 'unsecured; last claim is',
      lastValue.toString(), 'prepared amount', amount, 'newPrepared',
      newPrepared.toString(), 'prepared', prepared.toString())

    if (unsecured.greaterThan(this._bandwidth)) {
      throw new Error('Insufficient bandwidth, used: ' + unsecured + ' max: ' +
        this._bandwidth)
    }

    if (newPrepared.greaterThan(util.xrpToDrops(paychan.amount))) {
      throw new Error('Insufficient funds, have: ' + util.xrpToDrops(paychan.amount) +
        ' need: ' + newPrepared.toString())
    }

    this._balances.set(account, newPrepared.toString())
    debug(`account ${account} debited ${amount} units, new balance ${newPrepared.toString()}`)
  }

  _rejectIncomingTransfer (account, ilpData) {
    const { amount } = IlpPacket.deserializeIlpPrepare(ilpData)
    const prepared = new BigNumber(this._balances.get(account))
    const newPrepared = prepared.sub(amount)

    this._balances.set(account, newPrepared)
    debug(`account ${account} roll back ${amount} units, new balance ${newPrepared.toString()}`)
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
          throw new Error(`condition and fulfillment don\'t match.
            condition=${preparePacket.data.executionCondition}
            fulfillment=${parsedResponse.data.fulfillment}`)
      }

      // send off a transfer in the background to settle
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
            destination=${data}
            error=${e.message}`)
        })
    }
  }

  async sendMoney () {
    // NO-OP
  }

  _sendMoneyToAccount (transferAmount, to) {
    const account = ilpAddressToAccount(this._prefix, to)
    const balanceKey = account + ':outgoing_balance'

    const currentBalance = new BigNumber(this._balances.get(balanceKey) || 0)
    const newBalance = currentBalance.add(transferAmount)

    // TODO: fund if above a certain threshold (50%?)

    this._balances.set(balanceKey, newBalance.toString())
    debug(`account ${balanceKey} added ${transferAmount} units, new balance ${newBalance}`)

    // sign a claim
    const channel = this._balances.get(account + ':client_channel')
    const encodedClaim = util.encodeClaim(newBalance.toString(), channel)
    const keyPairSeed = util.hmac(this._secret, CHANNEL_KEYS + account)
    const keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)
    const signature = nacl.sign.detached(encodedClaim, keyPair.secretKey)

    debug(`signing outgoing claim for ${newBalance.toString()} drops on ` +
      `channel ${channel}`)

    const aboveThreshold = new BigNumber(util
      .xrpToDrops(this._clientPaychans.get(account).amount))
      .minus(OUTGOING_CHANNEL_DEFAULT_AMOUNT / 2)
      .lessThan(newBalance.toString())

    // if the claim we're signing is for more than half the channel's balance, add some funds
    // TODO: can there be multiple funding transactions in flight?
    // TODO: should the amount of funding ramp up or go linearly?
    if (!this._funding.get(account) && aboveThreshold) {
      debug('adding funds to channel for account', account)
      this._funding.set(account, true)
      util.fundChannel({
        api: this._api,
        channel: channel,
        address: this._address,
        secret: this._secret,
        // TODO: configurable fund amount?
        amount: OUTGOING_CHANNEL_DEFAULT_AMOUNT
      })
        .then(async () => {
          this._funding.set(account, false)
          debug('completed fund tx for account', account)
          await this._call(this._prefix + account, {
            type: BtpPacket.TYPE_MESSAGE,
            requestId: await util._requestId(),
            data: { protocolData: [{
              protocolName: 'channel',
              contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
              data: Buffer.from(channel, 'hex')
            }] }
          })
        })
        .catch((e) => {
          debug('funding tx/notify failed:', e)
          this._funding.set(account, false)
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
    const channel = this._balances.get(account + ':channel')
    const paychan = this._paychans.get(account)
    const { amount, signature } = claim
    const encodedClaim = util.encodeClaim(amount, channel)

    try {
      valid = nacl.sign.detached.verify(
        encodedClaim,
        Buffer.from(signature, 'hex'),
        Buffer.from(paychan.publicKey.substring(2), 'hex')
      )
    } catch (err) {
      debug('verifying signature failed:', err.message)
    }
    // TODO: better reconciliation if claims are invalid
    if (!valid) {
      debug(`got invalid claim signature ${signature} for amount ${amount} drops`)
      /*throw new Error('got invalid claim signature ' +
        signature + ' for amount ' + amount + ' drops')*/
      throw new Error('Invalid claim: invalid signature')
    }

    // validate claim against balance
    const channelBalance = util.xrpToDrops(paychan.amount)
    if (new BigNumber(amount).gt(channelBalance)) {
      const message = 'got claim for amount higher than channel balance. amount: ' + amount + ', incoming channel balance: ' + channelBalance
      debug(message)
      //throw new Error(message)
      throw new Error('Invalid claim: claim amount (' + amount + ') exceeds channel balance (' + channelBalance + ')')
    }

    const lastClaim = this._getLastClaim(account)
    const lastValue = new BigNumber(lastClaim.amount)
    if (lastValue.lt(amount)) {
      this._balances.set(account + ':claim', JSON.stringify(claim))
    }
    debug('set new claim for amount', amount)
  }

  _handleMoney (from, btpData) {
    const account = ilpAddressToAccount(this._prefix, from)

    // TODO: match the transfer amount
    const [ jsonClaim ] = btpData.data.protocolData
      .filter(p => p.protocolName === 'claim')
    const claim = JSON.parse(jsonClaim.data.toString())

    if (!claim) {
      debug('no claim was supplied on transfer')
      throw new Error('No claim was supplied on transfer') 
    }

    this._handleClaim(account, claim)
  }

  _getLastClaim (account) {
    return JSON.parse(this._balances.get(account + ':claim') || '{"amount":"0"}')
  }

  async _disconnect () {
    for (const interval of this._claimIntervalIds) {
      clearInterval(interval)
    }
  }
}

Plugin.version = 2
module.exports = Plugin
