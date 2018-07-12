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
const BLOCK_REASON = (a: string) => a + ':block_reason'
const CLIENT_CHANNEL = (a: string) => a + ':client_channel'
const OUTGOING_BALANCE = (a: string) => a + ':outgoing_balance'
const LAST_CLAIMED = (a: string) => a + ':last_claimed'
// TODO: the channels to accounts map

const RETRY_DELAY = 2000
const DEFAULT_BLOCK_REASON = 'channel must be re-established'

export interface AccountParams {
  account: string
  store: StoreWrapper
  api: RippleAPI
  currencyScale: number,
  log: any
}

export enum ReadyState {
  INITIAL = 0,
  LOADING_CHANNEL = 1,
  ESTABLISHING_CHANNEL = 2,
  PREPARING_CHANNEL = 3,
  LOADING_CLIENT_CHANNEL = 4,
  ESTABLISHING_CLIENT_CHANNEL = 5,
  PREPARING_CLIENT_CHANNEL = 6,
  READY = 7,
  BLOCKED = 8
}

function stateToString (state: ReadyState): string {
  switch (state) {
    case ReadyState.INITIAL: return 'INITIAL'
    case ReadyState.LOADING_CHANNEL: return 'LOADING_CHANNEL'
    case ReadyState.ESTABLISHING_CHANNEL: return 'ESTABLISHING_CHANNEL'
    case ReadyState.PREPARING_CHANNEL: return 'PREPARING_CHANNEL'
    case ReadyState.LOADING_CLIENT_CHANNEL: return 'LOADING_CLIENT_CHANNEL'
    case ReadyState.ESTABLISHING_CLIENT_CHANNEL: return 'ESTABLISHING_CLIENT_CHANNEL'
    case ReadyState.PREPARING_CLIENT_CHANNEL: return 'PREPARING_CLIENT_CHANNEL'
    case ReadyState.READY: return 'READY'
    case ReadyState.BLOCKED: return 'BLOCKED'
  }
}

export class Account {
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
  private _state: ReadyState

  constructor (opts: AccountParams) {
    this._store = opts.store
    this._account = opts.account
    this._api = opts.api
    this._currencyScale = opts.currencyScale
    this._funding = false
    this._log = opts.log
    this._state = ReadyState.INITIAL
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

  async connect (): Promise<void> {
    this._assertState(ReadyState.INITIAL)

    await Promise.all([
      this._store.load(BALANCE(this._account)),
      this._store.loadObject(INCOMING_CLAIM(this._account)),
      this._store.load(CHANNEL(this._account)),
      this._store.load(IS_BLOCKED(this._account)),
      this._store.load(BLOCK_REASON(this._account)),
      this._store.load(CLIENT_CHANNEL(this._account)),
      this._store.load(OUTGOING_BALANCE(this._account)),
      this._store.load(LAST_CLAIMED(this._account))
    ])

    if (this._store.get(IS_BLOCKED(this._account)) === 'true') {
      this._state = ReadyState.BLOCKED
      return
    }

    this._state = ReadyState.LOADING_CHANNEL
    return this._connectChannel()
  }

  async _connectChannel (): Promise<void> {
    this._assertState(ReadyState.LOADING_CHANNEL)

    const channelId = this._store.get(CHANNEL(this._account))
    if (channelId) {
      try {
        const paychan = await this._api.getPaymentChannel(channelId) as Paychan
        this._paychan = paychan
        this.setLastClaimedAmount(this.xrpToBase(paychan.balance))

        this._state = ReadyState.LOADING_CLIENT_CHANNEL
        return this._connectClientChannel()
      } catch (e) {
        this._log.error('failed to load channel entry. error=' + e.message)
        if (e.name === 'RippledError' && e.message === 'entryNotFound') {
          this._log.error('removing channel because it has been deleted')
          this.block(true, 'channel cannot be loaded. channelId=' + channelId)
          this.deleteChannel()
          return // TODO: do we need to do anything with the client channel still?
        } else if (e.name === 'TimeoutError') {
          // TODO: should this apply for all other errors too?
          this._log.error('timed out loading channel. retrying. account=' + this.getAccount())
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
          return this._connectChannel()
        }
      }
    } else {
      this._state = ReadyState.ESTABLISHING_CHANNEL
    }
  }

  async _connectClientChannel (): Promise<void> {
    this._assertState(ReadyState.LOADING_CLIENT_CHANNEL)

    const clientChannelId = this._store.get(CLIENT_CHANNEL(this._account))
    if (clientChannelId) {
      try {
        this._clientPaychan = await this._api.getPaymentChannel(clientChannelId) as Paychan
        this._state = ReadyState.READY
      } catch (e) {
        this._log.error('failed to load client channel entry. error=' + e.message)
        if (e.name === 'RippledError' && e.message === 'entryNotFound') {
          this._log.error('blocking account because client channel cannot be loaded.')
          this.block(true, 'client channel cannot be loaded. clientChannelId=' + clientChannelId)
          return // TODO: do we need to do anything with the client channel still?
        } else if (e.name === 'TimeoutError') {
          this._log.error('timed out loading client channel. retrying. account=' + this.getAccount())
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
          return this._connectClientChannel()
        }
      }
    } else {
      // in this scenario we have a channel but no client channel. that means we
      // should make one
      this._state = ReadyState.ESTABLISHING_CLIENT_CHANNEL
    }
  }

  disconnect () {
    this._state = ReadyState.BLOCKED
    this._store.unload(BALANCE(this._account))
    this._store.unload(INCOMING_CLAIM(this._account))
    this._store.unload(CHANNEL(this._account))
    this._store.unload(IS_BLOCKED(this._account))
    this._store.unload(BLOCK_REASON(this._account))
    this._store.unload(CLIENT_CHANNEL(this._account))
    this._store.unload(OUTGOING_BALANCE(this._account))
    const interval = this.getClaimIntervalId()
    if (interval) clearInterval(interval)
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

  getChannel (): string {
    const channel = this._store.get(CHANNEL(this._account))
    if (!channel) {
      throw new Error('channel does not exist on this account')
    }

    return channel
  }

  isBlocked () {
    return this._state === ReadyState.BLOCKED ||
      this._store.get(IS_BLOCKED(this._account)) === 'true'
  }

  getBlockReason () {
    return this._state === ReadyState.BLOCKED &&
      (this._store.get(BLOCK_REASON(this._account)) || DEFAULT_BLOCK_REASON)
  }

  getClientChannel () {
    const clientChannel = this._store.get(CLIENT_CHANNEL(this._account))
    if (!clientChannel) {
      throw new Error('clientChannel does not exist on this account')
    }

    return clientChannel
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

  prepareChannel () {
    this._assertState(ReadyState.ESTABLISHING_CHANNEL)
    this._state = ReadyState.PREPARING_CHANNEL
  }

  resetChannel () {
    this._assertState(ReadyState.PREPARING_CHANNEL)
    this._state = ReadyState.ESTABLISHING_CHANNEL
  }

  async setChannel (channel: string, paychan: Paychan) {
    this._assertState(ReadyState.PREPARING_CHANNEL)
    this._paychan = paychan
    this.setLastClaimedAmount(this.xrpToBase(paychan.balance))
    this._store.set(CHANNEL(this._account), channel)

    this._state = ReadyState.LOADING_CLIENT_CHANNEL
    return this._connectClientChannel()
  }

  reloadChannel (channel: string, paychan: Paychan) {
    if (this.getState() < ReadyState.LOADING_CLIENT_CHANNEL) {
      throw new Error('state must be at least LOADING_CLIENT_CHANNEL to reload channel details.' +
        ' state=' + this.getStateString())
    }
    this._paychan = paychan
    this.setLastClaimedAmount(this.xrpToBase(paychan.balance))
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

  block (isBlocked = true, reason = DEFAULT_BLOCK_REASON) {
    if (isBlocked) {
      this._state = ReadyState.BLOCKED
      this._store.set(BLOCK_REASON(this._account), reason)
    }
    return this._store.set(IS_BLOCKED(this._account), String(isBlocked))
  }

  prepareClientChannel () {
    this._assertState(ReadyState.ESTABLISHING_CLIENT_CHANNEL)
    this._state = ReadyState.PREPARING_CLIENT_CHANNEL
  }

  resetClientChannel () {
    this._assertState(ReadyState.PREPARING_CLIENT_CHANNEL)
    this._state = ReadyState.ESTABLISHING_CLIENT_CHANNEL
  }

  setClientChannel (clientChannel: string, clientPaychan: Paychan) {
    this._assertState(ReadyState.PREPARING_CLIENT_CHANNEL)

    this._clientPaychan = clientPaychan
    this._store.set(CLIENT_CHANNEL(this._account), clientChannel)
    this._state = ReadyState.READY
  }

  reloadClientChannel (clientChannel: string, clientPaychan: Paychan) {
    this._assertState(ReadyState.READY)
    this._clientPaychan = clientPaychan
    this._store.set(CLIENT_CHANNEL(this._account), clientChannel)
  }

  setOutgoingBalance (outgoingBalance: string) {
    return this._store.set(OUTGOING_BALANCE(this._account), outgoingBalance)
  }

  isReady () {
    return this._state === ReadyState.READY
  }

  getState () {
    return this._state
  }

  getStateString () {
    return stateToString(this._state)
  }

  private _assertState (state: ReadyState) {
    if (this._state !== state) {
      throw new Error(`account must be in state ${stateToString(state)}.` +
        ' state=' + this.getStateString() +
        ' account=' + this.getAccount())
    }
  }
}
