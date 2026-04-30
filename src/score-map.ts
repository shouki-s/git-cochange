export interface ScoreMapJSON {
  raw: Array<[string, Array<[string, number]>]>
  self: Array<[string, number]>
}

export class ScoreMap {
  private readonly raw = new Map<string, Map<string, number>>()
  private readonly self = new Map<string, number>()

  add(a: string, b: string, w: number): void {
    let inner = this.raw.get(a)
    if (!inner) {
      inner = new Map()
      this.raw.set(a, inner)
    }
    inner.set(b, (inner.get(b) ?? 0) + w)
  }

  addSelf(f: string, w: number): void {
    this.self.set(f, (this.self.get(f) ?? 0) + w)
  }

  normalize(a: string, b: string): number {
    const selfA = this.self.get(a) ?? 0
    const selfB = this.self.get(b) ?? 0
    if (selfA === 0 || selfB === 0) return 0
    const rawAB = this.raw.get(a)?.get(b) ?? 0
    return rawAB / Math.sqrt(selfA * selfB)
  }

  selfScore(f: string): number {
    return this.self.get(f) ?? 0
  }

  files(): IterableIterator<string> {
    return this.self.keys()
  }

  related(f: string): IterableIterator<string> {
    return (this.raw.get(f) ?? new Map<string, number>()).keys()
  }

  toJSON(): ScoreMapJSON {
    const raw: Array<[string, Array<[string, number]>]> = []
    for (const [a, inner] of this.raw) {
      raw.push([a, Array.from(inner.entries())])
    }
    return { raw, self: Array.from(this.self.entries()) }
  }

  static fromJSON(data: ScoreMapJSON): ScoreMap {
    const m = new ScoreMap()
    for (const [a, inner] of data.raw) {
      const innerMap = new Map<string, number>(inner)
      m.raw.set(a, innerMap)
    }
    for (const [f, w] of data.self) {
      m.self.set(f, w)
    }
    return m
  }
}
