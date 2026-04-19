# CLAUDE.md

設計上の決定・仕様はすべて **SPEC.md** に記録されている。実装に入る前に必ず確認すること。

## アーキテクチャ

```
src/
  git.ts      — simple-git で git log を取得（--name-only）、現存ファイルのみフィルタ
  scorer.ts   — スコア計算（時間減衰、author制約、正規化）
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
- 削除済みファイルは `getFiles()` に含めない
- `allPairs()` メソッドは提供しない（`getFiles()` + `getRelated()` の組み合わせで対応）
- キャッシュ・ディスク永続化なし（将来フェーズで実装予定、SPEC.md 参照）
