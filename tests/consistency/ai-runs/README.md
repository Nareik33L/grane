# AI-consistency runs (Release 1 item 5b)

Unedited attempt JSON, transcripts, and a generated score against #117
handwritten SQL. Method: [`docs/consistency.md`](../../../docs/consistency.md).

```
npx tsx tests/consistency/ai-runs/build-prompts.ts   # regenerate prompts/ from catalog
npx tsx tests/consistency/ai-runs/record.ts          # execute attempts/ → transcripts/
npx tsx tests/consistency/ai-runs/score.ts           # transcripts/ → SCORE.json + SUMMARY.md
```

Do not hand-edit `transcripts/`, `SCORE.json`, or `SUMMARY.md`.
