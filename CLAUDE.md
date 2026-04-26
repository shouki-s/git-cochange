# CLAUDE.md

設計上の決定・仕様はすべて **SPEC.md** に記録されている。実装に入る前に必ず確認すること。

## アーキテクチャ

```
src/
  git.ts      — simple-git で git log / ls-files / rev-parse を取得
  scorer.ts   — スコア計算（時間減衰、author制約、正規化）。ScoreMap の (de)serialize と incremental update を提供
  cache.ts    — キャッシュの読み書き、無効化判定、増分更新の組み立て
  analyzer.ts — 公開クラス Analyzer（analyze / getFiles / getRelated）
  index.ts    — 公開 API エクスポートのみ
```

## スコアリングモデルの要点

- 減衰関数: `exp(-Δt / τ)`、τ = 8時間（固定、ユーザー設定不可）
- 打ち切り: 5τ = 40時間（これ以上離れたペアは計算スキップ）
- 同一 author email のコミット間のみスコアを計算する
- 正規化: `score(A,B) = raw(A,B) / sqrt(raw(A,A) × raw(B,B))`（値域 0〜1、対称）

## 意図的にしていないこと

- リネーム/移動の追跡なし（現在のパスの履歴のみ対象）
- 削除済みファイルは `getFiles()` に含めない（フィルタはクエリ時に適用、内部 `ScoreMap` は保持）
- `allPairs()` メソッドは提供しない（`getFiles()` + `getRelated()` の組み合わせで対応）

## キャッシュ

- ディスク永続化あり、デフォルト有効。詳細は SPEC §9 参照。
- 既定パス: `<git-dir>/git-cochange/cache.json`
- 加法的スコアリングを利用した増分更新あり（テールバッファに直近 5τ のコミットを保持）
