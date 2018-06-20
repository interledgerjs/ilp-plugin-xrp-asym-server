import { Store } from './util'

export default class StoreWrapper {
  private _store?: Store
  private _cache: Map<string, string | void>
  private _write: Promise<void>

  constructor (store: Store) {
    this._store = store
    this._cache = new Map()
    this._write = Promise.resolve()
  }

  async load (key: string) {
    if (!this._store) return
    if (this._cache.has(key)) return
    const value = await this._store.get(key)

    // once the call to the store returns, double-check that the cache is still empty.
    if (!this._cache.has(key)) this._cache.set(key, value)
  }

  unload (key: string) {
    if (this._cache.has(key)) {
      this._cache.delete(key)
    }
  }

  get (key: string): string | void {
    return this._cache.get(key)
  }

  set (key: string, value: string) {
    this._cache.set(key, value)
    this._write = this._write.then(() => {
      if (this._store) {
        return this._store.put(key, value)
      }
    })
  }

  delete (key: string) {
    this._cache.delete(key)
    this._write = this._write.then(() => {
      if (this._store) {
        return this._store.del(key)
      }
    })
  }

  setCache (key: string, value: string) {
    this._cache.set(key, value)
  }
}
