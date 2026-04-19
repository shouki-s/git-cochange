# git-cochange

git のコミットログを解析し、ファイル間の関連度を算出するライブラリ。

## Installation

```bash
npm install git-cochange
```

## Usage

```ts
import { Analyzer } from 'git-cochange'

const analyzer = new Analyzer('/path/to/repo')
await analyzer.analyze()

const files = analyzer.getFiles()
const related = analyzer.getRelated('src/api.ts')
// → [{ file: 'src/types.ts', score: 0.91 }, ...]
```

## API

### `new Analyzer(repoPath, options?)`

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `ref` | `string` | `'HEAD'` | 解析対象の git ref |
| `includeMergeCommits` | `boolean` | `false` | マージコミットを含めるか |

### `analyzer.analyze(): Promise<void>`

git ログを取得してスコアを計算する。他のメソッドより先に呼ぶ必要がある。

### `analyzer.getFiles(): string[]`

スコアリングされた全ファイルのパス（リポジトリルートからの相対パス）を返す。

### `analyzer.getRelated(file: string): RelatedFile[]`

指定ファイルの関連ファイルをスコア降順で返す。

```ts
interface RelatedFile {
  file: string   // リポジトリルートからの相対パス
  score: number  // 0〜1
}
```

## Development

```bash
npm run build      # TypeScript コンパイル（dist/ に出力）
npx tsc --noEmit   # 型チェックのみ
```
