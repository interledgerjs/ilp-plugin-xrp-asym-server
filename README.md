# ILP Plugin XRP Asym Server

```
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
