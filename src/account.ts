'use strict'

const debug = require('debug')('ilp-plugin-xrp-asym-server:account')
import BigNumber from 'bignumber.js'
import {
  Claim,
  Paychan
} from './util'

const BALANCE = (a: string) => a
const INCOMING_CLAIM = (a: string) => a + ':claim'
const CHANNEL = (a: string) => a + ':channel'
const IS_BLOCKED = (a: string) => a + ':block'
const CLIENT_CHANNEL = (a: string) => a + ':client_channel'
const OUTGOING_BALANCE = (a: string) => a + ':outgoing_balance'
const LAST_CLAIMED = (a: string) => a + ':last_claimed'
// TODO: the channels to accounts map

export interface AccountParams {
  account: string
  store: any
  api: any
  currencyScale: number
}

export default class Account {
  private _store: any // TODO: store type
  private _account: string
  private _api: any // TODO: rippleAPI type?
  private _currencyScale: number
  private _paychan?: Paychan // TODO: paychan details type
  private _clientPaychan?: Paychan
  private _clientChannel?: string
  private _funding: boolean
  private _claimIntervalId?: number

  constructor (opts: AccountParams) {
    this._store = opts.store
    this._account = opts.account
    this._api = opts.api
    this._currencyScale = opts.currencyScale
    this._funding = false
  }

  xrpToBase (amount: string | BigNumber): string {
    return new BigNumber(amount)
      .times(Math.pow(10, this._currencyScale))
      .toString()
  }

  getAccount (): string {
    return this._account
  }

  getPaychan (): any {
    return this._paychan
  }

  getClientPaychan (): Paychan | void {
    return this._clientPaychan
  }

  setClaimIntervalId (claimIntervalId: number) {
    this._claimIntervalId = claimIntervalId
  }

  getClaimIntervalId (): number | void {
    return this._claimIntervalId
  }

  getLastClaimedAmount (): string {
    return this._store.get(LAST_CLAIMED(this._account)) || '0'
  }

  setLastClaimedAmount (amount: string) {
    this._store.set(LAST_CLAIMED(this._account), amount)
  }

  isFunding (): boolean {
    return this._funding
  }

  setFunding (funding: boolean) {
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
        const paychan = await this._api.getPaymentChannel(this.getChannel()) as Paychan
        this._paychan = paychan
        this.setLastClaimedAmount(this.xrpToBase(paychan.balance))
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

  getIncomingClaim (): Claim {
    const paychanAmount = new BigNumber(this.getLastClaimedAmount())
    const storedClaim = JSON.parse(this._store.get(INCOMING_CLAIM(this._account)) ||
      '{"amount":"0"}')

    if (paychanAmount.gt(storedClaim.amount)) {
      return { amount: paychanAmount.toString() }
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

  setBalance (balance: string) {
    return this._store.set(BALANCE(this._account), balance)
  }

  setIncomingClaim (incomingClaim: Claim) {
    return this._store.set(INCOMING_CLAIM(this._account), JSON.stringify(incomingClaim))
  }

  setChannel (channel: string, paychan: Paychan) {
    this._paychan = paychan
    this.setLastClaimedAmount(this.xrpToBase(paychan.balance))
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

  async setClientChannel (clientChannel: string) {
    this._clientPaychan = await this._api.getPaymentChannel(clientChannel)
    return this._store.set(CLIENT_CHANNEL(this._account), clientChannel)
  }

  setOutgoingBalance (outgoingBalance: string) {
    return this._store.set(OUTGOING_BALANCE(this._account), outgoingBalance)
  }
}
