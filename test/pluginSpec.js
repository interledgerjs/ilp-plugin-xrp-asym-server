'use strict' /* eslint-env mocha */

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

const PluginXrpAsymServer = require('..')
const Store = require('./util/memStore')
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
  before(async function () {
    const plugin = createPlugin()
    plugin._api.disconnect = () => {}
    plugin._api.submit = () => Promise.resolve({
      resultCode: 'tesSUCCESS'
    })
    await plugin.connect()
    this._submitterApi = plugin._api // use this API object to intercept tx prepare|sign|submit
    await plugin.disconnect()
  })

  describe('constructor', function () {
    it('should throw if currencyScale is neither undefined nor a number', function () {
      assert.throws(() => createPlugin({ currencyScale: 'oaimwdaiowdoamwdaoiw' }),
        /opts.currencyScale must be a number if specified/)
    })
  })

  beforeEach(async function () {
    this.timeout(10000)
    this.sinon = sinon.sandbox.create()
    this.plugin = createPlugin()
    this.plugin._api.disconnect = () => {}
    this.plugin._api.submit = () => Promise.resolve({
      resultCode: 'tesSUCCESS'
    })

    debug('connecting plugin')
    await this.plugin.connect()
    debug('connected')
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

  describe('handle custom data', () => {
    describe('channel protocol', () => {
      beforeEach(async function () {
        this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
        this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
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

    it('should load details for existing paychan', async function () {
      const spy = this.sinon.spy(this.plugin._api, 'getPaymentChannel')
      this.plugin._store.setCache(this.account + ':channel', this.channelId)

      await this.plugin._connect(this.from, {})
      assert.isTrue(spy.calledWith(this.channelId))
      assert.equal(this.plugin._channelToAccount.get(this.channelId).getAccount(), this.account)
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
      const info2 = this.plugin._extraInfo(this.account)
      assert.equal(info2.channel, this.channelId)
    })

    it('should return client channel if it exists', function () {
      const info = this.plugin._extraInfo(this.account)
      assert.equal(info.clientChannel, undefined)

      this.plugin._store.setCache(this.account.getAccount() + ':client_channel', this.channelId)
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
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', JSON.stringify({
        amount: '12345',
        signature: 'foo'
      }))
      this.account._paychan = { publicKey: 'bar', balance: '0' }
    })

    it('should create a fund transaction with proper parameters', async function () {
      const prepStub = this.sinon.stub(this._submitterApi, 'preparePaymentChannelClaim').returns({ txJSON: 'xyz' })
      const signStub = this.sinon.stub(this._submitterApi, 'sign').returns({ signedTransaction: 'abc' })
      const submitStub = this.sinon.stub(this._submitterApi, 'submit').returns(Promise.resolve({
        resultCode: 'tesSUCCESS'
      }))

      await this.plugin._channelClaim(this.account)
      assert.isTrue(prepStub.calledWith(this.plugin._address, {
        balance: '0.012345',
        signature: 'FOO',
        publicKey: 'bar',
        channel: this.channelId
      }))
      assert.isTrue(signStub.calledWith('xyz'))
      assert.isTrue(submitStub.calledWith('abc'))
    })

    it('should give an error if submit fails', async function () {
      this.sinon.stub(this._submitterApi, 'preparePaymentChannelClaim').returns({ txJSON: 'xyz' })
      this.sinon.stub(this._submitterApi, 'sign').returns({ signedTransaction: 'abc' })
      this.sinon.stub(this._submitterApi, 'submit').returns(Promise.resolve({
        resultCode: 'temMALFORMED',
        resultMessage: 'malformed'
      }))

      await assert.isRejected(
        this.plugin._channelClaim(this.account),
        'Error submitting claim: malformed')
    })
  })

  describe('handle money', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', JSON.stringify({
        amount: '12345',
        signature: 'foo'
      }))
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

        assert.isTrue(spy.calledWith(JSON.stringify(this.claim)))
      })
    })
  })

  describe('send money', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':client_channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', JSON.stringify({
        amount: '12345',
        signature: 'foo'
      }))
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
          this.plugin._store.setCache(this.account.getAccount() + ':outgoing_balance', 990)
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

        this.plugin._sendMoneyToAccount(500000, this.from)
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
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', JSON.stringify({
        amount: '12345',
        signature: 'foo'
      }))
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

      const res = await this.plugin._handleCustomData(this.from, this.prepare)

      assert.equal(res[0].protocolName, 'ilp')

      const parsed = IlpPacket.deserializeIlpReject(res[0].data)

      assert.deepEqual(parsed, {
        code: 'F02',
        triggeredBy: 'test.example.',
        message: 'Incoming traffic won\'t be accepted until a channel to the connector is established.',
        data: Buffer.alloc(0)
      })
    })
  })

  describe('handle prepare response', () => {
    beforeEach(async function () {
      this.from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
      this.channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
      this.account = await this.plugin._getAccount(this.from)
      this.plugin._store.setCache(this.account.getAccount() + ':channel', this.channelId)
      this.plugin._store.setCache(this.account.getAccount() + ':claim', JSON.stringify({
        amount: '12345',
        signature: 'foo'
      }))
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
        type: IlpPacket.Type.TYPE_ILP_REJECT
      }

      this.sinon.stub(this.plugin, '_sendMoneyToAccount')
        .returns([])
      this.sinon.stub(require('ilp-plugin-xrp-paychan-shared').util, '_requestId')
        .returns(Promise.resolve(1))
    })

    it('should handle a prepare response (fulfill)', async function () {
      const stub = this.sinon.stub(this.plugin, '_call')
        .returns(Promise.resolve())

      this.plugin._handlePrepareResponse(this.from, this.fulfill, this.prepare)
      await new Promise(resolve => setTimeout(resolve, 10))
      assert.isTrue(stub.calledWith(this.from, {
        type: BtpPacket.TYPE_TRANSFER,
        requestId: 1,
        data: {
          amount: 123,
          protocolData: []
        }
      }))
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
  })
})
