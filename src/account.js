'use strict'

const debug = require('debug')('ilp-plugin-xrp-asym-server:account')
const BigNumber = require('bignumber.js')

const BALANCE = a => a
const INCOMING_CLAIM = a => a + ':claim'
const CHANNEL = a => a + ':channel'
const IS_BLOCKED = a => a + ':block'
const CLIENT_CHANNEL = a => a + ':client_channel'
const OUTGOING_BALANCE = a => a + ':outgoing_balance'
const LAST_CLAIMED = a => a + ':last_claimed'
// TODO: the channels to accounts map

class Account {
  constructor ({ account, store, api, currencyScale }) {
    this._store = store
    this._account = account
    this._api = api
    this._currencyScale = currencyScale

    this._paychan = null
    this._clientPaychan = null
    this._funding = null
    this._claimIntervalId = null
  }

  xrpToBase (amount) {
    return new BigNumber(amount)
      .times(Math.pow(10, this._currencyScale))
      .toString()
  }

  getAccount () {
    return this._account
  }

  getPaychan () {
    return this._paychan
  }

  getClientPaychan () {
    return this._clientPaychan
  }

  setClaimIntervalId (claimIntervalId) {
    this._claimIntervalId = claimIntervalId
  }

  getClaimIntervalId () {
    return this._claimIntervalId
  }

  getLastClaimedAmount () {
    return this._store.get(LAST_CLAIMED(this._account)) || '0'
  }

  setLastClaimedAmount (amount) {
    this._store.set(LAST_CLAIMED(this._account))
  }

  isFunding () {
    return this._funding
  }

  setFunding (funding) {
    this._funding = funding
  }

  async connect () {
    await Promise.all([
      this._store.load(BALANCE(this._account)),
      this._store.load(INCOMING_CLAIM(this._account)),
      this._store.load(CHANNEL(this._account)),
      this._store.load(IS_BLOCKED(this._account)),
      this._store.load(CLIENT_CHANNEL(this._account)),
      this._store.load(OUTGOING_BALANCE(this._account)),
      this._store.load(LAST_CLAIMED(this._account))
    ])

    if (this.getChannel()) {
      try {
        this._paychan = await this._api.getPaymentChannel(this.getChannel())
        this.setLastClaimedAmount(this.xrpToBase(this._paychan.balance))
      } catch (e) {
        debug('failed to load channel entry. error=' + e.message)
        if (e.name === 'RippledError' && e.message === 'entryNotFound') {
          debug('removing channel because it has been deleted')
          this.deleteChannel()
        }
      }
    }

    if (this.getClientChannel()) {
      this._clientPaychan = await this._api.getPaymentChannel(this.getClientChannel())
        .catch(() => ({}))
    }
  }

  async disconnect () {
    this._store.unload(BALANCE(this._account))
    this._store.unload(INCOMING_CLAIM(this._account))
    this._store.unload(CHANNEL(this._account))
    this._store.unload(IS_BLOCKED(this._account))
    this._store.unload(CLIENT_CHANNEL(this._account))
    this._store.unload(OUTGOING_BALANCE(this._account))
  }

  getBalance () {
    return new BigNumber(this._store.get(BALANCE(this._account)) || '0')
  }

  getIncomingClaim () {
    const paychanAmount = new BigNumber(this.getLastClaimedAmount())
    const storedClaim = JSON.parse(this._store.get(INCOMING_CLAIM(this._account)) ||
      '{"amount":"0"}')

    if (paychanAmount.gt(storedClaim.amount)) {
      return { amount: paychanAmount }
    } else {
      return storedClaim
    }
  }

  getChannel () {
    return this._store.get(CHANNEL(this._account))
  }

  isBlocked () {
    return this._store.get(IS_BLOCKED(this._account))
  }

  getClientChannel () {
    return this._store.get(CLIENT_CHANNEL(this._account))
  }

  getOutgoingBalance () {
    return new BigNumber(this._store.get(OUTGOING_BALANCE(this._account)))
  }

  setBalance (balance) {
    return this._store.set(BALANCE(this._account), balance)
  }

  setIncomingClaim (incomingClaim) {
    return this._store.set(INCOMING_CLAIM(this._account), incomingClaim)
  }

  setChannel (channel, paychan) {
    this._paychan = paychan
    this.setLastClaimedAmount(this.xrpToBase(this._paychan.balance))
    return this._store.set(CHANNEL(this._account), channel)
  }

  deleteChannel () {
    if (new BigNumber(this.getLastClaimedAmount()).lt(this.getIncomingClaim().amount)) {
      console.error('Critical Error! Full balance was not able to be claimed before channel deletion.' +
        ' claim=' + this._store.get(INCOMING_CLAIM(this._account)) +
        ' lastClaimedAmount=' + this.getLastClaimedAmount() +
        ' channelId=' + this._store.get(CHANNEL(this._account)))
    }

    const newBalance = new BigNumber(this.getBalance())
      .minus(this.getLastClaimedAmount())
      .toString()

    this.setBalance(newBalance)

    delete this._paychan

    this._store.delete(LAST_CLAIMED(this._account))
    this._store.delete(INCOMING_CLAIM(this._account))
    return this._store.delete(CHANNEL(this._account))
  }

  block (isBlocked = true) {
    return this._store.set(IS_BLOCKED(this._account), isBlocked)
  }

  async setClientChannel (clientChannel) {
    this._clientPaychan = await this._api.getPaymentChannel(clientChannel)
    return this._store.set(CLIENT_CHANNEL(this._account), clientChannel)
  }

  setOutgoingBalance (outgoingBalance) {
    return this._store.set(OUTGOING_BALANCE(this._account), outgoingBalance)
  }
}

module.exports = Account
