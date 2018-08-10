'use strict' /* eslint-env mocha */

const BigNumber = require('bignumber.js')
const BtpPacket = require('btp-packet')
const IlpPacket = require('ilp-packet')
const crypto = require('crypto')
const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const sinon = require('sinon')
const debug = require('debug')('ilp-plugin-xrp-asym-server:test')
const nacl = require('tweetnacl')
const EventEmitter = require('events')

const PluginXrpAsymServer = require('..')
const Store = require('./util/memStore')
const { ReadyState } = require('../src/account')
const {
  util
} = require('ilp-plugin-xrp-paychan-shared')

function createPlugin (opts = {}) {
  return new PluginXrpAsymServer(Object.assign({
    prefix: 'test.example.',
    port: 3033,
    address: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
    secret: 'snRHsS3wLzbfeDNSVmtLKjE6sPMws',
    xrpServer: 'wss://s.altnet.rippletest.net:51233',
    claimInterval: 1000 * 30,
    bandwidth: 1000000,
    _store: new Store(null, 'test.example.'),
    debugHostIldcpInfo: {
      clientAddress: 'test.example',
      assetScale: 6,
      assetCode: 'XRP'
    }
  }, opts))
}

describe('pluginSpec', () => {
  describe('constructor', function () {
    it('should throw if currencyScale is neither undefined nor a number', function () {
      assert.throws(() => createPlugin({ currencyScale: 'oaimwdaiowdoamwdaoiw' }),
        /currency scale must be a number if specified/)
    })
  })

  beforeEach(async function () {
    this.timeout(10000)
    this.sinon = sinon.sandbox.create()
    this.plugin = createPlugin()
    this.plugin._api.connect = () => Promise.resolve()
    this.plugin._api.connection = new EventEmitter()
    this.plugin._api.connection.request = () => Promise.resolve()
    this.plugin._api.disconnect = () => Promise.resolve()
    this.plugin._api.getPaymentChannel = () => Promise.resolve({
      account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
      amount: '1',
      balance: '0',
      destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
      publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
      settleDelay: 3600,
      sourceTag: 1280434065,
      previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
      previousAffectingTransactionLedgerVersion: 6089142
    })
    this.plugin._api.submit = () => Promise.resolve({
      resultCode: 'tesSUCCESS'
    })

    debug('connecting plugin')
    await this.plugin.connect()
    debug('connected')

    this.feeStub = this.sinon.stub(this.plugin._api, 'getFee')
      .resolves('0.000016')
  })

  afterEach(async function () {
    this.sinon.restore()
    await this.plugin.disconnect()
  })

  describe('validate channel details', () => {
    beforeEach(function () {
      this.paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }
    })

    it('should not accept a channel with a short settle delay', function () {
      this.paychan.settleDelay = 1
      assert.throws(
        () => this.plugin._validatePaychanDetails(this.paychan),
        'settle delay of incoming payment channel too low')
    })

    it('should not accept a channel with a cancelAfter', function () {
      this.paychan.cancelAfter = new Date(Date.now() + 50000000)
      assert.throws(
        () => this.plugin._validatePaychanDetails(this.paychan),
        'channel must not have a cancelAfter')
    })

    it('should not accept a channel with an expiration', function () {
      this.paychan.expiration = new Date(Date.now() + 50000000)
      assert.throws(
        () => this.plugin._validatePaychanDetails(this.paychan),
        'channel must not be in the process of closing')
    })

    it('should not accept a channel for someone else', function () {
      this.paychan.destination = this.paychan.account
      assert.throws(
        () => this.plugin._validatePaychanDetails(this.paychan),
        'Channel destination address wrong')
    })

    it('should accept a channel which does not have any flaws', function () {
      this.plugin._validatePaychanDetails(this.paychan)
    })
  })

  describe('set client channel', () => {
    beforeEach(async function () {
      this.accountId = '35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.plugin._channelToAccount.set(this.channelId, this.account)
      this.paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }
      this.account._state = ReadyState.PREPARING_CHANNEL
      await this.account.setChannel(this.channelId, this.paychan)
      this.account._state = ReadyState.PREPARING_CLIENT_CHANNEL
    })

    it('should set outgoing balance to client channel balance if higher', async function () {
      assert.equal(this.account.getOutgoingBalance().toString(), '0')

      await this.account.setClientChannel(this.channelId, { balance: '1' })
      assert.equal(this.account.getOutgoingBalance().toString(), '1000000')
    })

    it('should set outgoing balance if higher when connecting client channel', async function () {
      this.account._state = ReadyState.LOADING_CLIENT_CHANNEL
      this.account._store.setCache(this.accountId + ':client_channel', 'client_channel_id')
      const stub = this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .resolves({
          balance: '1'
        })

      assert.equal(this.account.getOutgoingBalance().toString(), '0')
      await this.account._connectClientChannel()
      assert.equal(this.account.getOutgoingBalance().toString(), '1000000')
    })

    it('should not set outgoing balance if higher when connecting client channel', async function () {
      this.account._state = ReadyState.LOADING_CLIENT_CHANNEL
      this.account._store.setCache(this.accountId + ':client_channel', 'client_channel_id')
      const stub = this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .resolves({
          balance: '1'
        })

      this.account.setOutgoingBalance('2000000')
      assert.equal(this.account.getOutgoingBalance().toString(), '2000000')
      await this.account._connectClientChannel()
      assert.equal(this.account.getOutgoingBalance().toString(), '2000000')
    })

    it('should not set outgoing balance to client channel balance if not higher', async function () {
      this.account.setOutgoingBalance('2000000')
      assert.equal(this.account.getOutgoingBalance().toString(), '2000000')

      await this.account.setClientChannel(this.channelId, { balance: '1' })
      assert.equal(this.account.getOutgoingBalance().toString(), '2000000')
    })
  })

  describe('channel close', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.plugin._channelToAccount.set(this.channelId, this.account)
      this.paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }
      this.account._state = ReadyState.PREPARING_CHANNEL
      await this.account.setChannel(this.channelId, this.paychan)
      this.account._state = ReadyState.PREPARING_CLIENT_CHANNEL
      await this.account.setClientChannel(this.channelId, { balance: '0' })
      this.account.setIncomingClaim({
        amount: 1000,
        signature: 'foo'
      })
    })

    it('should call channelClose when close event is emitted', async function () {
      const closeStub = this.sinon.stub(this.plugin, '_channelClose').resolves()
      await this.plugin._watcher.emitAsync('channelClose', this.channelId, this.paychan)
      assert.deepEqual(closeStub.firstCall.args, [ this.channelId ])
    })

    it('should submit the correct claim tx on channel close', async function () {
      this.account.setBalance('1000')
      const submitStub = this.sinon.stub(this.plugin._txSubmitter, 'submit').resolves()

      await this.plugin._channelClose(this.channelId)

      const [ method, args ] = submitStub.firstCall.args
      assert.equal(method, 'preparePaymentChannelClaim')
      assert.equal(args.balance, '0.001000')
      assert.equal(args.publicKey, 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D')
      assert.equal(args.channel, this.channelId)
      assert.equal(args.close, true)
    })
  })

  describe('handle custom data', () => {
    describe('channel protocol', () => {
      beforeEach(async function () {
        this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
        this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
        this.account = await this.plugin._getAccount(this.from)
        this.plugin._channelToAccount.set(this.channelId, this.account)
        this.paychan = {
          account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
          amount: '1',
          balance: '0',
          destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
          publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
          settleDelay: 3600,
          sourceTag: 1280434065,
          previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
          previousAffectingTransactionLedgerVersion: 6089142
        }
        this.account._state = ReadyState.PREPARING_CHANNEL
        await this.account.setChannel(this.channelId, this.paychan)
        this.plugin._channelToAccount.set(this.channelId, this.account)
        this.account._state = ReadyState.READY
        this.channelSig = '9F878049FBBF4CEBAB29E6D840984D777C10ECE0FB96B0A56FF2CBC90D38DD03571A7D95A7721173970D39E1FC8AE694D777F5363AA37950D91F9B4B7E179C00'
        this.channelProtocol = {
          data: {
            protocolData: [{
              protocolName: 'channel',
              contentType: 0,
              data: Buffer.from(this.channelId, 'hex') },
            { protocolName: 'channel_signature',
              contentType: 0,
              data: Buffer.from(this.channelSig, 'hex') }]
          }
        }
      })

      it('does not race when assigning a channel to an account', async function () {
        this.account._state = ReadyState.ESTABLISHING_CHANNEL

        const getStub = this.sinon.stub(this.plugin._store._store, 'get')
        getStub.withArgs('channel:' + this.channelId).onFirstCall().callsFake(() => {
          // simulate another process writing to the cache while we wait for the store to return
          this.plugin._store.set('channel:' + this.channelId, 'some_other_account')
          return Promise.resolve(null)
        })

        return assert.isRejected(this.plugin._handleCustomData(this.from, this.channelProtocol),
          'this channel has already been associated with a different account. ' +
          'account=35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak associated=some_other_account')
      })

      it('don\'t throw if an account associates the same paychan again', async function () {
        const sendChannelProof = () => this.plugin._handleCustomData(this.from, this.channelProtocol)
        return assert.isFulfilled(Promise.all([sendChannelProof(), sendChannelProof()]))
      })
    })
  })

  describe('connect account', () => {
    beforeEach(function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = '35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
    })

    it('should check for existing paychan', async function () {
      const spy = this.sinon.spy(this.plugin._store._store, 'get')
      await this.plugin._connect(this.from, {})
      assert.isTrue(spy.calledWith(this.account + ':channel'))
    })

    it('should reject and give block reason if account blocked', async function () {
      const account = await this.plugin._getAccount(this.from)
      await account.connect()
      account.block(true, 'blocked for a reason')

      await assert.isRejected(this.plugin._connect(this.from, {}),
        /cannot connect to blocked account. reconfigure your uplink to connect with a new payment channel. reason=blocked for a reason/)
    })

    it('should load details for existing paychan', async function () {
      const spy = this.sinon.spy(this.plugin._api, 'getPaymentChannel')
      this.plugin._store.setCache(this.account + ':channel', this.channelId)

      await this.plugin._connect(this.from, {})
      assert.isTrue(spy.calledWith(this.channelId))
      assert.equal(this.plugin._channelToAccount.get(this.channelId).getAccount(), this.account)
    })

    it('should load lastClaimedAmount successfully', async function () {
      this.plugin._api.getPaymentChannel = () => Promise.resolve({
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0.000050',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      })

      this.plugin._store.setCache(this.account + ':channel', this.channelId)
      await this.plugin._connect(this.from, {})
      assert.equal(this.plugin._channelToAccount.get(this.channelId).getLastClaimedAmount(), '50')
    })

    it('should delete persisted paychan if it does not exist on the ledger', async function () {
      this.plugin._store.setCache(this.account + ':channel', this.channelId)
      const stub = this.sinon.stub(this.plugin._api, 'getPaymentChannel').callsFake(async () => {
        const error = new Error()
        error.name = 'RippledError'
        error.message = 'entryNotFound'
        throw error
      })

      await assert.isRejected(this.plugin._connect(this.from, {}))
      assert.isTrue(stub.calledWith(this.channelId))
      assert.isNotOk(this.plugin._channelToAccount.get(this.channelId))
      assert.isNotOk(this.plugin._store.get(this.account + ':channel'))
      assert.isNotOk(this.plugin._store.get(this.account + ':last_claimed'))
    })
  })

  describe('get extra info', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
    })

    it('should return channel if it exists', function () {
      const info = this.plugin._extraInfo(this.account)
      assert.equal(info.channel, undefined)

      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.account._state = ReadyState.LOADING_CLIENT_CHANNEL

      const info2 = this.plugin._extraInfo(this.account)
      assert.equal(info2.channel, this.channelId)
    })

    it('should return client channel if it exists', function () {
      const info = this.plugin._extraInfo(this.account)
      assert.equal(info.clientChannel, undefined)

      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':client_channel', this.channelId)
      this.account._state = ReadyState.READY

      const info2 = this.plugin._extraInfo(this.account)
      assert.equal(info2.clientChannel, this.channelId)
    })

    it('should return full address', function () {
      const info = this.plugin._extraInfo(this.account)
      assert.equal(info.account, this.from)
    })
  })

  describe('channel claim', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.account._state = ReadyState.READY
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', {
        amount: '12345',
        signature: 'foo'
      })
      this.account._paychan = { publicKey: 'bar', balance: '0' }
    })

    it('should create a fund transaction with proper parameters', async function () {
      const stub = this.sinon.stub(this.plugin._txSubmitter, 'submit').resolves()
      await this.plugin._channelClaim(this.account)
      assert(stub.calledWithExactly('preparePaymentChannelClaim', {
        balance: '0.012345',
        signature: 'FOO',
        publicKey: 'bar',
        close: false,
        channel: '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      }), 'unexpected args: ' + JSON.stringify(stub.args))
    })

    it('should scale the claim amount appropriately', async function () {
      this.plugin._currencyScale = 9
      const stub = this.sinon.stub(this.plugin._txSubmitter, 'submit').resolves()
      await this.plugin._channelClaim(this.account)
      assert(stub.calledWithExactly('preparePaymentChannelClaim', {
        balance: '0.000013',
        signature: 'FOO',
        publicKey: 'bar',
        close: false,
        channel: '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      }), 'unexpected args: ' + JSON.stringify(stub.args))
    })

    it('should give an error if submit fails', async function () {
      const api = this.plugin._txSubmitter._api
      this.sinon.stub(api, 'preparePaymentChannelClaim').returns({ txJSON: 'xyz' })
      this.sinon.stub(api, 'sign').returns({ signedTransaction: 'abc' })
      this.sinon.stub(api, 'submit').returns(Promise.resolve({
        resultCode: 'temMALFORMED',
        resultMessage: 'malformed'
      }))

      await assert.isRejected(
        this.plugin._channelClaim(this.account),
        'Error submitting claim')
    })

    it('should not auto claim when more has been claimed than the plugin thought', async function () {
      this.plugin._api.getPaymentChannel = () => Promise.resolve({
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0.012345',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      })

      const stub = this.sinon.stub(this.plugin._txSubmitter, 'submit').resolves()
      await this.plugin._channelClaim(this.account)
      assert.isFalse(stub.called, 'claim should not have been submitted')
    })
  })

  describe('handle money', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.account._state = ReadyState.READY
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', {
        amount: '12345',
        signature: 'foo'
      })
      this.account._paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }
    })

    it('should throw error if no claim protocol is present', function () {
      assert.throws(
        () => this.plugin._handleMoney(this.from, { requestId: 10, data: { protocolData: [] } }),
        'got transfer with empty protocolData. requestId=10')
    })

    it('should throw error if claim protocol is empty', function () {
      assert.throws(
        () => this.plugin._handleMoney(this.from, { data: { protocolData: [{
          protocolName: 'claim',
          data: Buffer.alloc(0)
        }] }}),
        'No claim was supplied on transfer')
    })

    it('should pass claim to _handleClaim if present', function () {
      const stub = this.sinon.stub(this.plugin, '_handleClaim')
      this.plugin._handleMoney(this.from, { data: { protocolData: [{
        protocolName: 'claim',
        data: Buffer.from('{}')
      }] }})

      assert.isTrue(stub.calledWith(this.account, {}))
    })

    describe('_handleClaim', () => {
      beforeEach(function () {
        this.claim = {
          amount: 12345,
          signature: 'foo'
        }
      })

      it('should throw if the signature is not valid', function () {
        assert.throws(
          () => this.plugin._handleClaim(this.account, this.claim),
          'Invalid claim: invalid signature')
      })

      it('should throw if the signature is for a higher amount than the channel max', function () {
        this.claim.amount = 1000001
        // This stub works because require uses a cache
        this.sinon.stub(require('tweetnacl').sign.detached, 'verify')
          .returns(true)

        assert.throws(
          () => this.plugin._handleClaim(this.account, this.claim),
          'Invalid claim: claim amount (1000001) exceeds channel balance (1000000)')
      })

      it('should not save the claim if it is lower than the previous', function () {
        // This stub works because require uses a cache
        this.sinon.stub(require('tweetnacl').sign.detached, 'verify')
          .returns(true)

        const spy = this.sinon.spy(this.account, 'setIncomingClaim')
        this.plugin._handleClaim(this.account, this.claim)

        assert.isFalse(spy.called)
        // assert.isTrue(spy.calledWith(JSON.stringify(this.claim)))
      })

      it('should save the claim if it is higher than the previous', function () {
        // This stub works because require uses a cache
        this.claim.amount = 123456
        this.sinon.stub(require('tweetnacl').sign.detached, 'verify')
          .returns(true)

        const spy = this.sinon.spy(this.account, 'setIncomingClaim')
        this.plugin._handleClaim(this.account, this.claim)

        assert.isTrue(spy.calledWith(this.claim))
      })
    })
  })

  describe('send money', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.account._state = ReadyState.READY
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':client_channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', {
        amount: '12345',
        signature: 'foo'
      })
      this.plugin._store.setCache(this.account.getAccount() + ':outgoing_balance', '12345')
      this.claim = {
        amount: '12345',
        signature: 'foo'
      }
      this.account._clientPaychan = this.account._paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }
    })

    describe('_sendMoneyToAccount', () => {
      it('should return a claim for a higher balance', function () {
        const oldAmount = Number(this.claim.amount)
        const [ claim ] = this.plugin._sendMoneyToAccount(100, this.from)

        assert.equal(claim.protocolName, 'claim')
        assert.equal(claim.contentType, 2)

        const parsed = JSON.parse(claim.data.toString())
        assert.equal(Number(parsed.amount), oldAmount + 100)
      })

      describe('with high scale', function () {
        beforeEach(function () {
          this.plugin._currencyScale = 9

          this.sinon.stub(nacl.sign, 'detached').returns('abcdef')

          this.plugin._keyPair = {}
          this.plugin._funding = true
          this.plugin._store.setCache(this.account.getAccount() + ':outgoing_balance', '990')
        })

        it('should issue a fund and throw an error if amount is above the capacity', function () {
          const stub = this.sinon.stub(require('ilp-plugin-xrp-paychan-shared').util, 'fundChannel')
            .returns(Promise.resolve())

          const initialOutgoingBalance = this.account.getOutgoingBalance()
          assert.throws(() => this.plugin._sendMoneyToAccount(1000000000, this.from),
            /channel does not have enough capacity to process claim. claimAmount=1000001 clientPaychan.amount=1000000/)
          assert.equal(this.account.getOutgoingBalance().toString(), initialOutgoingBalance.toString())

          assert.isTrue(stub.calledWith({
            api: this.plugin._api,
            channel: this.channelId,
            address: this.plugin._address,
            secret: this.plugin._secret,
            amount: 1000000
          }))
        })

        it('should round high-scale amount up to next drop', async function () {
          const encodeSpy = this.sinon.spy(util, 'encodeClaim')
          this.sinon.stub(this.plugin, '_call').resolves(null)

          this.plugin._sendMoneyToAccount(100, this.from)

          assert.deepEqual(encodeSpy.getCall(0).args, [ '2', this.channelId ])
        })

        it('should scale up low-scale amount', async function () {
          this.plugin._currencyScale = 2
          const encodeSpy = this.sinon.spy(util, 'encodeClaim')
          this.sinon.stub(this.plugin, '_call').resolves(null)

          // make sure we don't exceed the channel balance
          this.account._clientPaychan.amount = 1e6
          this.plugin._sendMoneyToAccount(100, this.from)

          assert.deepEqual(encodeSpy.getCall(0).args, [ '10900000', this.channelId ])
        })

        it('should keep error under a drop even on repeated roundings', async function () {
          const encodeSpy = this.sinon.spy(util, 'encodeClaim')
          this.sinon.stub(this.plugin, '_call').resolves(null)

          this.plugin._sendMoneyToAccount(100, this.from)
          this.plugin._sendMoneyToAccount(100, this.from)

          assert.deepEqual(encodeSpy.getCall(0).args, [ '2', this.channelId ])
          assert.deepEqual(encodeSpy.getCall(1).args, [ '2', this.channelId ])
        })

        it('should handle a claim', async function () {
          // this stub isn't working, which is why handleMoney is throwing
          this.sinon.stub(nacl.sign.detached, 'verify').returns('abcdef')
          const encodeSpy = this.sinon.spy(util, 'encodeClaim')

          this.plugin._store.setCache(this.account.getAccount() + ':balance', 990)
          this.plugin._handleMoney(this.from, {
            requestId: 1,
            data: {
              amount: '160',
              protocolData: [{
                protocolName: 'claim',
                contentType: BtpPacket.MIME_APPLICATION_JSON,
                data: Buffer.from(JSON.stringify({
                  amount: '2150',
                  signature: 'abcdef'
                }))
              }]
            }
          })

          assert.deepEqual(encodeSpy.getCall(0).args, [ '3', this.channelId ])
        })
      })

      it('should not issue a fund if the amount is below the threshold', function () {
        const spy = this.sinon.spy(require('ilp-plugin-xrp-paychan-shared').util, 'fundChannel')
        this.plugin._sendMoneyToAccount(100, this.from)
        assert.isFalse(spy.called)
      })

      it('should issue a fund if the amount is above the threshold', function () {
        const stub = this.sinon.stub(require('ilp-plugin-xrp-paychan-shared').util, 'fundChannel')
          .returns(Promise.resolve())

        const initialOutgoingBalance = this.account.getOutgoingBalance()
        this.plugin._sendMoneyToAccount(500000, this.from)
        assert.equal(this.account.getOutgoingBalance().toString(),
          initialOutgoingBalance.plus(500000).toString())

        assert.isTrue(stub.calledWith({
          api: this.plugin._api,
          channel: this.channelId,
          address: this.plugin._address,
          secret: this.plugin._secret,
          amount: 1000000
        }))
      })

      it('should issue a fund and throw an error if amount is above the capacity', function () {
        const stub = this.sinon.stub(require('ilp-plugin-xrp-paychan-shared').util, 'fundChannel')
          .returns(Promise.resolve())

        const initialOutgoingBalance = this.account.getOutgoingBalance()
        assert.throws(() => this.plugin._sendMoneyToAccount(1000000, this.from),
          /channel does not have enough capacity to process claim. claimAmount=1012345 clientPaychan.amount=1000000/)
        assert.equal(this.account.getOutgoingBalance().toString(), initialOutgoingBalance.toString())

        assert.isTrue(stub.calledWith({
          api: this.plugin._api,
          channel: this.channelId,
          address: this.plugin._address,
          secret: this.plugin._secret,
          amount: 1000000
        }))
      })

      it('reloads client\'s paychan details after funding', async function () {
        this.sinon.stub(require('ilp-plugin-xrp-paychan-shared').util, 'fundChannel').resolves()
        const expectedClientChan = Object.assign({}, this.account._clientPaychan, {amount: '2'})
        sinon.stub(this.plugin._api, 'getPaymentChannel').resolves(expectedClientChan)

        // this will trigger a fund tx
        this.plugin._sendMoneyToAccount(500000, this.from)

        // wait for the fund tx to be completed
        await new Promise((resolve, reject) => {
          this.account.setFunding = () => resolve()
        })
        assert.deepEqual(this.account.getClientPaychan(), expectedClientChan,
          'expected client paychan to be updated after funding completed')
      })
    })
  })

  describe('handle custom data', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.account._state = ReadyState.READY
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', {
        amount: '12345',
        signature: 'foo'
      })
      this.account._paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }

      this.fulfillment = crypto.randomBytes(32)
      this.condition = crypto.createHash('sha256')
        .update(this.fulfillment)
        .digest()

      this.prepare = { data: { protocolData: [ {
        protocolName: 'ilp',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: IlpPacket.serializeIlpPrepare({
          destination: this.from,
          amount: '123',
          executionCondition: this.condition,
          expiresAt: new Date(Date.now() + 10000),
          data: Buffer.alloc(0)
        })
      } ] } }

      this.fulfill = { data: { protocolData: [ {
        protocolName: 'ilp',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: IlpPacket.serializeIlpFulfill({
          fulfillment: this.fulfillment,
          data: Buffer.alloc(0)
        })
      } ] } }

      this.sinon.stub(this.plugin, '_sendMoneyToAccount')
        .returns([])
      this.sinon.stub(require('ilp-plugin-xrp-paychan-shared').util, '_requestId')
        .returns(Promise.resolve(1))
    })

    it('should return a reject if the packet is too big', async function () {
      this.plugin._maxPacketAmount = new BigNumber(1000)
      this.prepare = { data: { protocolData: [ {
        protocolName: 'ilp',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: IlpPacket.serializeIlpPrepare({
          destination: this.from,
          amount: '1234567',
          executionCondition: this.condition,
          expiresAt: new Date(Date.now() + 10000),
          data: Buffer.alloc(0)
        })
      } ] } }

      const res = await this.plugin._handleCustomData(this.from, this.prepare)

      assert.equal(res[0].protocolName, 'ilp')

      const parsed = IlpPacket.deserializeIlpReject(res[0].data)

      assert.deepEqual(parsed, {
        code: 'F08',
        triggeredBy: 'test.example.',
        message: 'Packet size is too large.',
        data: Buffer.from([ 0, 0, 0, 0, 0, 18, 214, 135, 0, 0, 0, 0, 0, 0, 3, 232 ])
      })
    })

    it('should return a reject if insufficient bandwidth', async function () {
      this.prepare = { data: { protocolData: [ {
        protocolName: 'ilp',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: IlpPacket.serializeIlpPrepare({
          destination: this.from,
          amount: '1234567',
          executionCondition: this.condition,
          expiresAt: new Date(Date.now() + 10000),
          data: Buffer.alloc(0)
        })
      } ] } }

      const res = await this.plugin._handleCustomData(this.from, this.prepare)

      assert.equal(res[0].protocolName, 'ilp')

      const parsed = IlpPacket.deserializeIlpReject(res[0].data)

      assert.deepEqual(parsed, {
        code: 'T04',
        triggeredBy: 'test.example.',
        message: 'Insufficient bandwidth, used: 1222222 max: 1000000',
        data: Buffer.alloc(0)
      })
    })

    it('should return a reject if there is no channel to peer', async function () {
      delete this.account._paychan
      this.account._state = ReadyState.LOADING_CHANNEL

      const res = await this.plugin._handleCustomData(this.from, this.prepare)

      assert.equal(res[0].protocolName, 'ilp')

      const parsed = IlpPacket.deserializeIlpReject(res[0].data)

      assert.deepEqual(parsed, {
        code: 'F02',
        triggeredBy: 'test.example.',
        message: 'ilp packets will only be forwarded in READY state. state=LOADING_CHANNEL',
        data: Buffer.alloc(0)
      })
    })
  })

  describe('auto claim logic', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.account._state = ReadyState.READY
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':last_claimed', '12300')
      this.plugin._store.setCache(this.account.getAccount() + ':claim', {
        amount: '13901',
        signature: 'foo'
      })
      this.account._paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0.012300',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }
    })

    it('should auto claim when amount is more than 100 * fee + last claim', async function () {
      this.feeStub.resolves('0.000016')
      const stub = this.sinon.stub(this.plugin, '_channelClaim').resolves()

      await this.plugin._autoClaim(this.account)
      assert.isTrue(stub.called)
    })

    it('should not auto claim when amount is less than 100 * fee + last claim', async function () {
      this.feeStub.resolves('0.000017')
      const stub = this.sinon.stub(this.plugin, '_channelClaim').resolves()

      await this.plugin._autoClaim(this.account)
      assert.isFalse(stub.called)
    })

    describe('with high scale', () => {
      beforeEach(function () {
        this.plugin._currencyScale = 9
        this.plugin._store.setCache(this.account.getAccount() + ':last_claimed', '12300000')
        this.plugin._store.setCache(this.account.getAccount() + ':claim', {
          amount: '13901000',
          signature: 'foo'
        })
      })

      it('should auto claim when amount is more than 100 * fee + last claim', async function () {
        this.feeStub.resolves('0.000016')
        const stub = this.sinon.stub(this.plugin, '_channelClaim').resolves()

        await this.plugin._autoClaim(this.account)
        assert.isTrue(stub.called)
      })

      it('should not auto claim when amount is less than 100 * fee + last claim', async function () {
        this.feeStub.resolves('0.000017')
        const stub = this.sinon.stub(this.plugin, '_channelClaim').resolves()

        await this.plugin._autoClaim(this.account)
        assert.isFalse(stub.called)
      })
    })
  })

  describe('handle prepare response', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.account._state = ReadyState.READY
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', {
        amount: '12345',
        signature: 'foo'
      })
      this.account._paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }

      this.fulfillment = crypto.randomBytes(32)
      this.condition = crypto.createHash('sha256')
        .update(this.fulfillment)
        .digest()

      this.prepare = {
        type: IlpPacket.Type.TYPE_ILP_PREPARE,
        data: {
          destination: this.from,
          amount: 123,
          executionCondition: this.condition,
          expiresAt: new Date(Date.now() + 10000),
          data: Buffer.alloc(0)
        }
      }

      this.fulfill = {
        type: IlpPacket.Type.TYPE_ILP_FULFILL,
        data: {
          fulfillment: this.fulfillment,
          data: Buffer.alloc(0)
        }
      }

      this.reject = {
        type: IlpPacket.Type.TYPE_ILP_REJECT,
        data: {
          code: 'F00'
        }
      }

      this.sendMoneyStub = this.sinon.stub(this.plugin, '_sendMoneyToAccount')
        .returns([])
      this.sinon.stub(require('ilp-plugin-xrp-paychan-shared').util, '_requestId')
        .returns(Promise.resolve(1))
    })

    it('should handle a prepare response (fulfill)', async function () {
      const stub = this.sinon.stub(this.plugin, '_call')
        .returns(Promise.resolve())

      this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare)
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(this.account.getOwedBalance().toString(), '0')
      assert.deepEqual(stub.firstCall.args, [this.from, {
        type: BtpPacket.TYPE_TRANSFER,
        requestId: 1,
        data: {
          amount: '123',
          protocolData: []
        }
      }])
    })

    it('should settle owed balance in addition to prepare', async function () {
      const stub = this.sinon.stub(this.plugin, '_call')
        .returns(Promise.resolve())

      this.account.setOwedBalance('10')

      this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare)
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(this.account.getOwedBalance().toString(), '0')
      assert.deepEqual(stub.firstCall.args, [this.from, {
        type: BtpPacket.TYPE_TRANSFER,
        requestId: 1,
        data: {
          amount: '133',
          protocolData: []
        }
      }])
    })

    it('should ignore fulfillments for zero-amount packets', async function () {
      const stub = this.sinon.stub(this.plugin, '_call')
        .returns(Promise.resolve())

      this.prepare.data.amount = '0'

      this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare)
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.isFalse(stub.called)
    })

    it('should handle a prepare response on which transfer fails', async function () {
      this.sinon.stub(this.plugin, '_call')
        .returns(Promise.reject(new Error('no')))

      this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare)
    })

    it('should handle a prepare response (non-fulfill)', async function () {
      const stub = this.sinon.stub(this.plugin, '_call')
        .returns(Promise.resolve())

      this.plugin._handlePrepareResponse(this.from, this.reject, this.prepare)
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.isFalse(stub.called)
    })

    it('should handle a prepare response (invalid fulfill)', async function () {
      const stub = this.sinon.stub(this.plugin, '_call')
        .returns(Promise.resolve())

      this.fulfill.data.fulfillment = Buffer.from('garbage')
      assert.throws(
        () => this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare),
        IlpPacket.Errors.WrongConditionError,
        'condition and fulfillment don\'t match.')

      await new Promise(resolve => setTimeout(resolve, 10))
      assert.isFalse(stub.called)
    })

    it('should handle a prepare response (no channel to client)', async function () {
      const stub = this.sinon.stub(this.plugin, '_call')
        .returns(Promise.resolve())

      this.fulfill.data.fulfillment = Buffer.from('garbage')
      assert.throws(
        () => this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare),
        IlpPacket.Errors.WrongConditionError,
        'condition and fulfillment don\'t match.')

      await new Promise(resolve => setTimeout(resolve, 10))
      assert.isFalse(stub.called)
    })

    it('should increase owed amount when settle fails', async function () {
      const stub = this.sinon.stub(this.plugin, '_call')
        .returns(Promise.resolve())

      this.sendMoneyStub.throws(new Error('failed to sign claim'))

      this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare)
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.isFalse(stub.called)
      assert.equal(this.account.getOwedBalance().toString(), '123')

      this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare)
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.isFalse(stub.called)
      assert.equal(this.account.getOwedBalance().toString(), '246')
    })

    describe('T04 handling', () => {
      beforeEach(function () {
        this.reject.data.code = 'T04'
      })

      it('should trigger settlement on a T04 error', async function () {
        const stub = this.sinon.stub(this.plugin, '_call')
          .returns(Promise.resolve())

        this.account.setOwedBalance('10')

        this.plugin._handlePrepareResponse(this.from, this.reject, this.prepare)
        await new Promise(resolve => setTimeout(resolve, 10))
        assert.equal(this.account.getOwedBalance().toString(), '0')
        assert.isTrue(this.sendMoneyStub.calledWith('10', this.from))
        assert.deepEqual(stub.firstCall.args, [this.from, {
          type: BtpPacket.TYPE_TRANSFER,
          requestId: 1,
          data: {
            amount: '10',
            protocolData: []
          }
        }])
      })

      it('should not adjust owed balance if settle fails', async function () {
        const stub = this.sinon.stub(this.plugin, '_call')
          .returns(Promise.resolve())

        this.account.setOwedBalance('10')
        this.sendMoneyStub.throws(new Error('failed to sign claim'))

        this.plugin._handlePrepareResponse(this.from, this.reject, this.prepare)
        await new Promise(resolve => setTimeout(resolve, 10))
        assert.equal(this.account.getOwedBalance().toString(), '10')
        assert.isTrue(this.sendMoneyStub.calledWith('10', this.from))
        assert.isFalse(stub.called)
      })
    })
  })

  describe('Account', function () {
    beforeEach(function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = this.plugin._getAccount(this.from)
      this.paychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }
    })

    it('should block the account if the store says so', async function () {
      this.account._store.setCache(this.account.getAccount() + ':block', 'true')
      await this.account.connect()
      assert.equal(this.account.getStateString(), 'BLOCKED')
      assert.equal(this.account.getBlockReason(), 'channel must be re-established')
    })

    it('should set to ESTABLISHING_CHANNEL if no channel exists', async function () {
      await this.account.connect()
      assert.equal(this.account.getStateString(), 'ESTABLISHING_CHANNEL')
    })

    it('should load channel from ledger if it exists', async function () {
      this.account._store.setCache(this.account.getAccount() + ':channel', 'my_channel_id')
      this.sinon.stub(this.account._api, 'getPaymentChannel').resolves(this.paychan)
      await this.account.connect()
      assert.equal(this.account.getStateString(), 'ESTABLISHING_CLIENT_CHANNEL')
    })

    it('should retry call to ledger if channel gives timeout', async function () {
      this.account._store.setCache(this.account.getAccount() + ':channel', 'my_channel_id')
      this.sinon.stub(this.account._api, 'getPaymentChannel')
        .onFirstCall().callsFake(() => {
          const e = new Error('timed out')
          e.name = 'TimeoutError'
          throw e
        })
        .onSecondCall().resolves(this.paychan)

      const oldSetTimeout = setTimeout
      setTimeout = setImmediate
      await this.account.connect()
      setTimeout = oldSetTimeout

      assert.equal(this.account.getStateString(), 'ESTABLISHING_CLIENT_CHANNEL')
    })

    it('should retry call to ledger if client channel gives timeout', async function () {
      this.account._store.setCache(this.account.getAccount() + ':channel', 'my_channel_id')
      this.account._store.setCache(this.account.getAccount() + ':client_channel', 'my_channel_id')
      this.sinon.stub(this.account._api, 'getPaymentChannel')
        .onCall(0).resolves(this.paychan)
        .onCall(1).callsFake(() => {
          const e = new Error('timed out')
          e.name = 'TimeoutError'
          throw e
        })
        .onCall(2).resolves(this.paychan)

      const oldSetTimeout = setTimeout
      setTimeout = setImmediate
      await this.account.connect()
      setTimeout = oldSetTimeout

      assert.equal(this.account.getStateString(), 'READY')
    })
  })

  describe('admin interface', function () {
    beforeEach(async function () {
      this.sinon.stub(this.plugin._api, 'getAccountInfo')
        .resolves({
          xrpBalance: '10000',
          ownerCount: '200'
        })

      this.sinon.stub(this.plugin._api, 'getServerInfo')
        .resolves({
          validatedLedger: {
            reserveIncrementXRP: '4'
          }
        })

      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.account._state = ReadyState.READY
      this.plugin._store.setCache(this.account.getAccount() + ':client_channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', {
        amount: '12345',
        signature: 'foo'
      })
      this.account._paychan = this.account._clientPaychan = {
        account: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot',
        amount: '1',
        balance: '0',
        destination: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        publicKey: 'EDD69138B8AB9B0471A734927FABE2B20D2943215C8EEEC61DC11598C79424414D',
        settleDelay: 3600,
        sourceTag: 1280434065,
        previousAffectingTransactionID: '51F331B863D078CF5EFEF1FBFF2D0F4C4D12FD160272EEB03F572C904B800057',
        previousAffectingTransactionLedgerVersion: 6089142
      }
    })

    it('should get admin info', async function () {
      assert.deepEqual(await this.plugin.getAdminInfo(), {
        clients: [{
          account: '35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak',
          channel: '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0',
          channelBalance: '0',
          clientChannel: '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0',
          clientChannelBalance: '0.000000',
          state: 'READY',
          xrpAddress: 'rPbVxek7Bovu4pWyCfGCVtgGbhwL6D55ot'
        }],
        xrpAddress: 'r9Ggkrw4VCfRzSqgrkJTeyfZvBvaG9z3hg',
        xrpBalance: {
          'available': '9200',
          'reserved': '800',
          'total': '10000'
        }
      })
    })

    it('should apply a "settle" command', async function () {
      const idStub = this.sinon.stub(util, '_requestId').resolves(12345)
      const callStub = this.sinon.stub(this.plugin, '_call').resolves(null)
      const sendStub = this.sinon.stub(this.plugin, '_sendMoneyToAccount')
        .returns([])

      assert.deepEqual(await this.plugin.sendAdminInfo({
        command: 'settle',
        amount: '100',
        account: this.account.getAccount()
      }), {})
      assert.deepEqual(sendStub.firstCall.args, [ '100000000', this.from ])
      assert.deepEqual(callStub.firstCall.args, [
        'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak',
        {
         data: {
           amount: '100000000',
           protocolData: []
         },
         requestId: 12345,
         type: 7
        }
      ])
    })

    it('should apply a "block" command', async function () {
      assert.isFalse(this.account.isBlocked())
      assert.deepEqual(await this.plugin.sendAdminInfo({
        command: 'block',
        account: this.account.getAccount()
      }), {})
      assert.isTrue(this.account.isBlocked())
    })
  })
})
