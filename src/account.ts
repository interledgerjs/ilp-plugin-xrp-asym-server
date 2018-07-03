'use strict'

import { RippleAPI } from 'ripple-lib'
import BigNumber from 'bignumber.js'
import StoreWrapper from './store-wrapper'
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
  store: StoreWrapper
  api: RippleAPI
  currencyScale: number,
  log: any
}

export default class Account {
  private _store: StoreWrapper
  private _account: string
  private _api: RippleAPI // TODO: rippleAPI type?
  private _currencyScale: number
  private _paychan?: Paychan
  private _clientPaychan?: Paychan
  private _clientChannel?: string
  private _funding: boolean
  private _claimIntervalId?: number
  private _log: any

  constructor (opts: AccountParams) {
    this._store = opts.store
    this._account = opts.account
    this._api = opts.api
    this._currencyScale = opts.currencyScale
    this._funding = false
    this._log = opts.log
  }

  xrpToBase (amount: BigNumber.Value): string {
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
      this._store.loadObject(INCOMING_CLAIM(this._account)),
      this._store.load(CHANNEL(this._account)),
      this._store.load(IS_BLOCKED(this._account)),
      this._store.load(CLIENT_CHANNEL(this._account)),
      this._store.load(OUTGOING_BALANCE(this._account)),
      this._store.load(LAST_CLAIMED(this._account))
    ])

    const channelId = this.getChannel()
    if (channelId) {
      try {
        const paychan = await this._api.getPaymentChannel(channelId) as Paychan
        this._paychan = paychan
        this.setLastClaimedAmount(this.xrpToBase(paychan.balance))
      } catch (e) {
        this._log.error('failed to load channel entry. error=' + e.message)
        if (e.name === 'RippledError' && e.message === 'entryNotFound') {
          this._log.error('removing channel because it has been deleted')
          this.deleteChannel()
        }
      }
    }

    const clientChannelId = this.getClientChannel()
    if (clientChannelId) {
      this._clientPaychan = await this._api.getPaymentChannel(clientChannelId)
        .catch(() => ({})) as Paychan
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
    const storedClaim = this._store.getObject(INCOMING_CLAIM(this._account)) as Claim ||
      { amount: '0' }

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
    return this._store.get(IS_BLOCKED(this._account)) === 'true'
  }

  getClientChannel () {
    return this._store.get(CLIENT_CHANNEL(this._account))
  }

  getOutgoingBalance () {
    return new BigNumber(this._store.get(OUTGOING_BALANCE(this._account)) || '0')
  }

  setBalance (balance: string) {
    return this._store.set(BALANCE(this._account), balance)
  }

  setIncomingClaim (incomingClaim: Claim) {
    return this._store.set(INCOMING_CLAIM(this._account), incomingClaim)
  }

  setChannel (channel: string, paychan: Paychan) {
    this._paychan = paychan
    this.setLastClaimedAmount(this.xrpToBase(paychan.balance))
    return this._store.set(CHANNEL(this._account), channel)
  }

  deleteChannel () {
    if (new BigNumber(this.getLastClaimedAmount()).lt(this.getIncomingClaim().amount)) {
      this._log.error('Critical Error! Full balance was not able to be claimed before channel deletion.' +
        ' claim=' + JSON.stringify(this._store.getObject(INCOMING_CLAIM(this._account))) +
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
    return this._store.set(IS_BLOCKED(this._account), String(isBlocked))
  }

  async setClientChannel (clientChannel: string) {
    this._clientPaychan = await this._api.getPaymentChannel(clientChannel) as Paychan
    return this._store.set(CLIENT_CHANNEL(this._account), clientChannel)
  }

  setOutgoingBalance (outgoingBalance: string) {
    return this._store.set(OUTGOING_BALANCE(this._account), outgoingBalance)
  }
}
