export type Protocol = {
  protocolName: string
  contentType: number
  data: Buffer
}

export type BtpData = {
  data: {
    protocolData: Protocol[]
  }
  requestId: number
}

export type Claim = {
  signature?: string
  amount: string
}

export type Paychan = {
  account: string,
  amount: string,
  balance: string,
  publicKey: string,
  destination: string,
  settleDelay: number,
  expiration?: string,
  cancelAfter?: string,
  sourceTag?: number,
  destinationTag?: number,
  previousAffectingTransactionID: string,
  previousAffectingTransactionLedgerVersion: number
}

export type Store = {
  get: (key: string) => Promise<string | void>
  put: (key: string, value: string) => Promise<void>
  del: (key: string) => Promise<void>
}
