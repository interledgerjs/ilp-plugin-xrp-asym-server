'use strict' /* eslint-env mocha */

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const sinon = require('sinon')
const debug = require('debug')('ilp-plugin-xrp-asym-server:test')

const PluginBtp = require('ilp-plugin-btp')
const PluginXrpAsymServer = require('..')
const Store = require('./util/memStore')

describe('pluginSpec', () => {
  beforeEach(async function () {
    this.timeout(10000)
    this.plugin = new PluginXrpAsymServer({
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
    })

    debug('connecting plugin')
    await this.plugin.connect()
    debug('connected')
  })

  afterEach(async function () {
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
        const getStub = sinon.stub(this.plugin._store._store, 'get')
        getStub.withArgs('channel:' + this.channelId).onFirstCall().callsFake(() => {
          // simulate another process writing to the cache while we wait for the store to return
          this.plugin._store.set('channel:' + this.channelId, 'some_other_account')
          return Promise.resolve(null)
        })

        return assert.isRejected(this.plugin._handleCustomData(this.from, this.channelProtocol),
          'this channel has already been associated with a different account. ' + 
          'account=35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak associated=some_other_account')
      })

      it('don\'t throw if an account associates the same paychan again' , async function () {
        const sendChannelProof = () => this.plugin._handleCustomData(this.from, this.channelProtocol)
        return assert.isFulfilled(Promise.all([sendChannelProof(), sendChannelProof()]))
      })
    })
  })
})
