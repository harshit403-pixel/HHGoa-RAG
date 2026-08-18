## How the indexing pipeline works

The flow is implemented across these files:

- Parquet stream read: `get-data.ts`
- Chunking: `chunk-data.ts`
- Embedding: `embedder.ts`
- Vector index: `faiss-index.ts`
- Metadata store: `metadata-store.ts`
- Orchestration: `index-pipeline.ts`
- Paths/config: `config.ts`
- Resume/checkpoint: `checkpoint.ts`

### 1) It reads the Hugging Face dataset as parquet files

The code scans a directory for `.parquet` files, one per language, and streams rows from DuckDB instead of loading the whole file into memory. That logic is in `get-data.ts`.

Each row is decoded into a `PassageRow` with:

- `query_id`
- `target_lang`
- `passage_index`
- `passage`
- `is_selected`

### 2) It chunks each passage

In `chunk-data.ts`, each passage goes through `chunkPassage()`.

There are two chunking behaviors:

- Short passage: if `passage.length <= 900`, it keeps the whole passage as one chunk.
- Long passage: it uses `RecursiveCharacterTextSplitter` from LangChain.

The splitter uses:

- `chunkSize = 700`
- `chunkOverlap = 100`
- separators in this priority order:
    - blank lines
    - newlines
    - Hindi sentence enders (`। `, `॥ `)
    - English punctuation (`. `, `? `, `! `)
    - spaces
    - characters

So this is not a “semantic chunker” in the LLM-sense; it is a hierarchical recursive character splitter that tries to break text at meaningful boundaries before falling back to raw character splits.

The code labels chunks as:

- `whole` for short passages
- `semantic` for recursive split passages

> The name `semantic` is a bit misleading; it is really a recursive text split, not a semantic clustering step.

### 3) It embeds each chunk

Each chunk text is sent to an embedder from `embedder.ts`.

Supported options:

- `local` using `@xenova/transformers`
- `http` sending requests to an embedding service
- `Mistral` embedder also exists in the file

The embedding output is a flat `Float32Array` shaped as:

- `N * dimension`

This is important because FAISS expects that flat row-major layout directly.

### 4) It adds vectors to FAISS with explicit IDs

This is the key part.

In `faiss-index.ts`, the code does:

- builds a FAISS index via `IndexIDMap2`
- each vector gets a stable custom ID
- IDs are assigned from a monotonic checkpoint counter, not FAISS’s implicit insertion order

The code comment is explicit: they want a stable external ID so resume behavior and metadata lookups survive index rebuilds.

The index is created as:

- `HNSW32,Flat` by default (approximate, production path)
- or `IndexFlatL2` if `INDEX_TYPE` is set to `flat`

The actual vector insert is:

- `this.index.addWithIds(Array.from(vectors), ids);`

So the vectors are stored in a FAISS index object, not in a separate “vector table”.

---

## How the embeddings are stored in the vector DB

The short answer is:

- The vector DB is FAISS
- The actual file name is `index.faiss`
- It is stored under a per-language directory
- The metadata is kept separately in SQLite

From `config.ts`, the default root is:

- `INDEX_ROOT = /data/hhgoa/indexes`

Then for each language, the script writes:

- `/data/hhgoa/indexes/<language>/index.faiss`
- `/data/hhgoa/indexes/<language>/metadata.db`
- `/data/hhgoa/indexes/<language>/state.json`

And the orchestration in `index-pipeline.ts` does:

- `const dir = path.join(INDEX_ROOT, language);`
- `const indexFile = path.join(dir, "index.faiss");`

So the actual vector index filename is exactly:

- `index.faiss`

The SQLite metadata table is called:

- `chunks`

with a column:

- `faiss_id INTEGER PRIMARY KEY`

This `faiss_id` is the same ID used in the FAISS index. So the mapping looks like this:

- FAISS vector label = `faiss_id`
- SQLite row = same `faiss_id`
- chunk text and metadata are looked up by that `faiss_id`

This is why `metadata-store.ts` has a table schema like:

- `faiss_id`
- `chunk_id`
- `parent_id`
- `text`
- `query_id`
- `language`
- `passage_index`
- `is_selected`
- `chunk_index`
- `chunk_type`

and `addBatch()` writes rows with:

- `faiss_id: Number(faissIds[i])`

So the vector DB is not storing text in FAISS itself. FAISS stores numeric vectors + their IDs; the text/metadata is stored in SQLite for retrieval and display.

---

## General end-to-end flow

1. Read parquet rows from source dataset
2. Convert each text passage to one or more chunks
3. Embed each chunk with the chosen embedding model
4. Assign a stable `faiss_id` per chunk
5. Add vector + ID into FAISS
6. Save the same chunk metadata into SQLite via `faiss_id`
7. Periodically checkpoint:
    - save the FAISS index
    - checkpoint SQLite WAL
    - save `state.json`

This is all orchestrated in `index-pipeline.ts`, and the resume behavior is managed by `checkpoint.ts`.
