# ILP Plugin XRP Asym Server

ILP Plugin XRP Asym Server allows you to accept payment channel connections
from many users without adding them as peers. If you're running a connector,
this is a great way to get sub-connectors and provide ILP connection to users
without asking them to trust you with their money.

Details of how the connection is established are described in this plugin's
client,
[`ilp-plugin-xrp-asym-client`](https://github.com/interledgerjs/ilp-plugin-xrp-asym-client)

This plugin is based off of
[`ilp-plugin-mini-accounts`](https://github.com/interledgerjs/ilp-plugin-mini-accounts),
with XRP payment channel functionality on top.

```js
const serverPlugin = new IlpPluginXrpAsymServer({
  // Port on which to listen
  port: 6666,

  // XRP credentials of the server
  address: 'rKzfaLjeVZXasCSU2heTUGw9VhQmFNSd8k',
  secret: 'snHNnoL6S67wNvydcZg9y9bFzPZwG',

  // Rippled server for the server to use
  xrpServer: 'wss://s.altnet.rippletest.net:51233',

  // Max amount to be unsecured at any one time
  bandwidth: 1000000,

  // Persistent Key-value store. ILP-Connector will pass
  // this parameter in automatically.
  _store: new Store()
})
```
