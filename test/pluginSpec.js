'use strict' /* eslint-env mocha */

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const sinon = require('sinon')

const PluginXrpAsymServer = require('..')
const Store = require('./util/memStore')

describe('pluginSpec', () => {
  beforeEach(async () => {
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

    await this.plugin.connect()
  })

  afterEach(async () => {
    await this.plugin.disconnect()
  })

  describe('handle custom data', () => {
    describe('channel protocol', () => {
      it('does not race when assigning a channel to an account', () => {
        const from = 'test.example.35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak'
        const channelId = '45455C767516029F34E9A9CEDD8626E5D955964A041F6C9ACD11F9325D6164E0'
        const channelSig = '9F878049FBBF4CEBAB29E6D840984D777C10ECE0FB96B0A56FF2CBC90D38DD03571A7D95A7721173970D39E1FC8AE694D777F5363AA37950D91F9B4B7E179C00'
        const message = {
          data: {
            protocolData: [{
              protocolName: 'channel',
              contentType: 0,
              data: Buffer.from(channelId, 'hex') },
            { protocolName: 'channel_signature',
              contentType: 0,
              data: Buffer.from(channelSig, 'hex') }]
          }
        }

        const getStub = sinon.stub(this.plugin._store._store, 'get')
        getStub.withArgs('channel:' + channelId).onFirstCall().callsFake(() => {
          // simulate another process writing to the cache while we wait for the store to return
          this.plugin._store.set('channel:' + channelId, 'some_other_account')
          return Promise.resolve(null)
        })

        return assert.isRejected(this.plugin._handleCustomData(from, message),
          'this channel has already been associated with a different account. ' + 
          'account=35YywQ-3GYiO3MM4tvfaSGhty9NZELIBO3kmilL0Wak associated=some_other_account')
      })
    })
  })
})
