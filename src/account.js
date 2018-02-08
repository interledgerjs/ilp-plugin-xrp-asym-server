'use strict'

const BigNumber = require('bignumber.js')

const BALANCE = a => a
const INCOMING_CLAIM = a => a + ':claim'
const CHANNEL = a => a + ':channel'
const IS_BLOCKED = a => a + ':block'
const CLIENT_CHANNEL = a => a + ':client_channel'
const OUTGOING_BALANCE = a => a + ':outgoing_balance'
// TODO: the channels to accounts map

class Account {
  constructor ({ account, store, api }) {
    this._store = store
    this._account = account
    this._api = api

    this._paychan = null
    this._clientPaychan = null
    this._funding = null
    this._lastClaimedAmount = null
    this._claimIntervalId = null
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
    return this._lastClaimedAmount
  }

  setLastClaimedAmount (amount) {
    this._lastClaimedAmount = amount
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
      this._store.load(OUTGOING_BALANCE(this._account))
    ])

    if (this.getChannel()) {
      // hold empty paychan details if the channel no longer exists.
      // the channel will be cleaned up after failing validation.
      this._paychan = await this._api.getPaymentChannel(this.getChannel())
        .catch(() => ({}))
      this._lastClaimedAmount = this._paychan.balance
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
    const paychanAmount = new BigNumber(this._paychan ? this._paychan.balance : '0')
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
    this._lastClaimedAmount = this._paychan.balance
    return this._store.set(CHANNEL(this._account), channel)
  }

  deleteChannel () {
    delete this._paychan
    delete this._lastClaimedAmount
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
