import type { ProviderAdapter } from './types'

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>()

  constructor(adapters: readonly ProviderAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.id))
      throw new Error(`Provider "${adapter.id}" is already registered`)
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()]
  }
}
