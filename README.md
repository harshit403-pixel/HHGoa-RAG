# 🚀 Multilingual RAG Search Engine with FAISS & SQLite

A production-grade, ultra-fast **Multilingual Retrieval-Augmented Generation (RAG)** search engine. This system combines **FAISS** (HNSW vector similarity index) and a local **SQLite** metadata database to execute sub-millisecond document retrievals, integrated with **Sarvam AI** (for voice transcription and query translation) and **Mistral AI** (for query embeddings and streaming LLM generation via **LangChain**).

---

## 🏗️ System Architecture Flow

The system runs in two main pipelines: **Indexing** (offline compilation) and **Retrieval & Answer Generation** (online runtime). 

---

### High-Level Pipelines Overview

#### 1. Offline Indexing Pipeline
```mermaid
graph TD
    A[hinval.parquet / Multilingual Corpus] --> B[Semantic & Window Chunking]
    B --> C[English Alignment Translation]
    C --> D[Mistral text-embedding-v1]
    D --> E[FAISS HNSW Vector Index]
    C --> F[SQLite Metadata Database metadata.db]
    F -->|Keyed by faiss_id| E
```

#### 2. Online Retrieval & Generation Pipeline
```mermaid
graph TD
    User([User Voice or Text]) --> STT{Voice Input?}
    STT -->|Yes| STT_Proc[Sarvam Speech-to-Text]
    STT -->|No| Guard[Input Guardrails Check]
    STT_Proc --> Trans[Sarvam Translation to English]
    Trans --> Guard
    Guard -->|Passed| Embed[Mistral Query Embedding]
    Guard -->|Blocked| Block[Reject & Emit Error]
    Embed --> FAISS[FAISS Similarity Search]
    FAISS -->|Top 5 Matches| Ground{Groundedness Check}
    Ground -->|Passed| SQL[SQLite Context Retrieval]
    Ground -->|Failed| Fallback[LLM General Knowledge Fallback]
    SQL --> LLM[LangChain ChatMistralAI Stream]
    Fallback --> LLM
    LLM --> Stream([Streaming Answer to UI])
```

---

### Detailed System Architecture Flowchart

The following interactive flowchart maps the exact architecture, logic branches, and SSE channel communication routes of the system.

```mermaid
flowchart TD
    %% Offline Indexing Pipeline (Left Stream)
    subgraph Offline_Indexing ["Offline Indexing Pipeline"]
        id_dataset[MS MARCO Dataset] --> id_extract[Passage Extraction]
        id_extract --> id_chunk_decision{Length > 900?}
        id_chunk_decision -->|No / Short Passage| id_whole[Whole Passage Chunk]
        id_chunk_decision -->|Yes / Long Passage| id_split[RecursiveCharacterTextSplitter]
        id_split --> id_size[Chunk Size: 700]
        id_size --> id_overlap[Overlap: 100]
        id_whole --> id_format[Chunk Formatting<br/>chunk_id, parent_id, passage_index, chunk_index, chunk_type]
        id_overlap --> id_format
        
        id_format --> id_mistral_emb[Mistral Embeddings<br/>mistral-embed]
        id_mistral_emb --> id_vectors[1024-D Vectors]
        id_vectors --> id_faiss_idx[FAISS Vector Index]
        
        id_format --> id_sqlite_meta[SQLite Metadata]
        id_sqlite_meta --> id_db_trans[12 Language Translations]
    end

    %% User & Audio Inputs (Right Stream)
    subgraph User_Input ["User Interaction & Inputs"]
        id_user[User] --> id_speak[Speak in Native Language]
        id_speak --> id_mic[Browser Microphone<br/>MediaStream + AudioAnalyser]
        id_mic --> id_blob[Raw Audio Blob<br/>POST to Backend]
        id_blob --> id_rec[Audio File Received]
        id_rec --> id_sse_conn[SSE Connection]
    end

    %% Center Retrieval & Inference Pipeline
    subgraph Retrieval_Inference ["Online Retrieval & Inference Pipeline"]
        id_rec --> id_sarvam_stt[Sarvam STT<br/>saaras:v3]
        id_sarvam_stt --> id_lang_check{English?}
        
        id_lang_check -->|Yes| id_eng_query[English Query]
        id_lang_check -->|No| id_sarvam_trans[Sarvam Translation<br/>mayura:v1]
        id_sarvam_trans --> id_eng_query
        
        id_eng_query --> id_guard[Input Guardrail]
        id_guard --> id_topic_check{Safe + On-Topic?}
        
        id_topic_check -->|No| id_reject[Reject Request]
        id_topic_check -->|Yes| id_query_emb[Mistral Embedding<br/>mistral-embed]
        
        id_query_emb --> id_query_vector[1024-D Query Vector]
        id_query_vector --> id_faiss_search[FAISS HNSW Vector Similarity Search]
        id_faiss_search --> id_topk[Top K = 5]
        id_topk --> id_chunk_ids[FAISS Chunk IDs]
        id_chunk_ids --> id_sqlite_lookup[SQLite Metadata Lookup]
        id_sqlite_lookup --> id_matched_context[Chunk Text + Metadata + Translations]
        
        id_matched_context --> id_ground_check[Grounding Guardrail]
        id_ground_check --> id_relevant_check{Relevant Context?}
        
        id_relevant_check -->|No| id_no_context[Cannot find answer in provided documents]
        id_relevant_check -->|Yes| id_select_lang[Select User Language]
        id_select_lang --> id_fetch_trans[Fetch Translation from SQLite]
        
        id_fetch_trans --> id_llm[Mistral Large<br/>temperature = 0]
        id_no_context --> id_llm
        
        id_llm --> id_stream_chunks[Streaming Answer Chunks]
    end

    %% SSE Channels & React UI (Bottom Blocks)
    id_sse_conn --> sse_status[event: status]
    id_sse_conn --> sse_meta[event: metadata]
    id_sse_conn --> sse_chunk[event: chunk]
    id_sse_conn --> sse_done[event: done]
    id_sse_conn --> sse_error[event: error]

    id_sarvam_stt -.-> sse_status
    id_guard -.-> sse_status
    id_sqlite_lookup -.-> sse_meta
    id_stream_chunks -.-> sse_chunk
    
    sse_status --> react_fe[React Frontend]
    sse_meta --> react_fe
    sse_chunk --> react_fe
    sse_done --> react_fe
    sse_error --> react_fe
    
    react_fe --> ui_ans[Answer]
    react_fe --> ui_sources[Retrieved Sources]
    react_fe --> ui_logs[Pipeline Execution Logs]
    react_fe --> ui_latencies[ui_diagnostics]

    %% Styling configurations
    style id_dataset fill:#f3e8ff,stroke:#8b5cf6,stroke-width:2px
    style id_whole fill:#f3e8ff,stroke:#8b5cf6,stroke-width:2px
    style id_split fill:#f3e8ff,stroke:#8b5cf6,stroke-width:2px
    style id_faiss_idx fill:#d8b4fe,stroke:#8b5cf6,stroke-width:2px
    style id_db_trans fill:#d8b4fe,stroke:#8b5cf6,stroke-width:2px

    style id_speak fill:#e6f4ea,stroke:#08733f,stroke-width:2px
    style id_mic fill:#e6f4ea,stroke:#08733f,stroke-width:2px
    style id_sse_conn fill:#e6f4ea,stroke:#08733f,stroke-width:2px

    style id_sarvam_stt fill:#d1fae5,stroke:#059669,stroke-width:2px
    style id_sarvam_trans fill:#ffe4e6,stroke:#e11d48,stroke-width:2px
    style id_guard fill:#fee2e2,stroke:#ef4444,stroke-width:2px
    style id_faiss_search fill:#e0f2fe,stroke:#0284c7,stroke-width:2px
    style id_sqlite_lookup fill:#e0f2fe,stroke:#0284c7,stroke-width:2px
    style id_llm fill:#fef3c7,stroke:#d97706,stroke-width:2px

    style sse_status fill:#1e293b,stroke:#475569,stroke-width:2px,color:#fff
    style sse_meta fill:#1e293b,stroke:#475569,stroke-width:2px,color:#fff
    style sse_chunk fill:#1e293b,stroke:#475569,stroke-width:2px,color:#fff
    style sse_done fill:#1e293b,stroke:#475569,stroke-width:2px,color:#fff
    style sse_error fill:#1e293b,stroke:#475569,stroke-width:2px,color:#fff
```

---

## 📝 Step-by-Step Execution Trace Examples

### 1. Offline Indexing Trace (Example Row)

#### Input Row
We start with a raw Hindi fact row from `hinval.parquet`:
* **`query_id`**: `42`
* **`passage_index`**: `3`
* **`target_lang`**: `"hi"`
* **`passage`**: `"भारत की राजधानी नई दिल्ली है। यह एक ऐतिहासिक शहर है जिसमें लाल किला और इंडिया गेट जैसे प्रसिद्ध स्मारक हैं।"`

#### Step 1: Chunking Selection (Strategy 1 - Whole)
* **Action**: The length of the passage is 95 characters.
* **Evaluation**: $95 \le 900$ (below the `SHORT_PASSAGE_CHARS` threshold).
* **Output**: The entire passage is kept as a single chunk.
  * `chunk_id`: `"42-p3-c0"`
  * `parent_id`: `"42-p3"`
  * `chunk_type`: `"whole"`

#### Step 2: English Translation Alignment
* **Action**: The chunk is sent to the Sarvam Translation API using the `mayura:v1` model.
  * `source_language_code`: `"hi"`
  * `target_language_code`: `"en-IN"`
* **Output**: The API returns the English aligned translation:
  * `translated_text`: `"New Delhi is the capital of India. It is a historical city with famous monuments like the Red Fort and India Gate."`

#### Step 3: Vector Embedding Generation
* **Action**: The English text is sent to the Mistral Embeddings API (`mistral-embed`).
* **Output**: The API returns a `Float32Array` of size 1024:
  * `vector`: `[0.0124, -0.0452, 0.0891, ..., 0.0031]`

#### Step 4: FAISS Registration
* **Action**: The vector is appended to the FAISS index with a unique sequential ID.
  * `faiss_id`: `1042` (monotonic counter)
* **Output**: The vector is inserted into the HNSW graph L2 space under ID `1042`.

#### Step 5: SQLite Database Injection
* **Action**: The metadata database stores the raw text and its translations.
* **SQL Query**:
  ```sql
  INSERT INTO chunks (faiss_id, chunk_id, parent_id, text, query_id, passage_index, chunk_index, chunk_type, translations)
  VALUES (
    1042, 
    '42-p3-c0', 
    '42-p3', 
    'New Delhi is the capital of India. It is a historical city with famous monuments like the Red Fort and India Gate.', 
    42, 
    3, 
    0, 
    'whole', 
    '{"hi": "भारत की राजधानी नई दिल्ली है। यह एक ऐतिहासिक शहर है जिसमें लाल किला और इंडिया गेट..."}'
  );
  ```
* **Result**: SQLite creates a B-Tree entry on the Primary Key `faiss_id`.

---

### 2. Online Retrieval Trace (Example Query)

#### Step 1: Speech-to-Text (STT)
* **Action**: User clicks the purple blob on the UI and speaks: *"भारत की राजधानी क्या है?"*
* **Transcription Output**: Sarvam's `saaras:v3` model transcribes the WAV audio buffer:
  * `transcript`: `"भारत की राजधानी क्या है?"`
  * `language_code`: `"hi-IN"`

#### Step 2: Query Translation Alignment
* **Action**: The transcribed Hindi text is sent to the Sarvam Translate API:
  * `input`: `"भारत की राजधानी क्या है?"`
  * `source_language_code`: `"hi"`
  * `target_language_code`: `"en-IN"`
* **Output**: The API returns:
  * `translated_text`: `"What is the capital of India?"`

#### Step 3: Input Guardrails Check
* **Action**: The query is scanned against the security and off-topic list.
  * Query: `"what is the capital of india?"`
  * Security Match: None.
  * Off-Topic Match: None.
* **Output**: Guardrails pass successfully.

#### Step 4: Query Embedding
* **Action**: The English query `"What is the capital of India?"` is embedded.
* **Output**: The Mistral Embeddings API returns a 1024-dimension query vector:
  * `queryVector`: `[0.0118, -0.0421, 0.0815, ..., 0.0029]`

#### Step 5: FAISS Similarity Search
* **Action**: The query vector is searched against the loaded HNSW L2 vector index (`activeFolder = "aligned_english"`).
* **Output**: FAISS finds the top matching vector IDs:
  * Match 1: `faiss_id = 1042`, `distance = 0.1423`

#### Step 6: Grounding Verification
* **Action**: The top match L2 score is evaluated against the `-5.0` confidence limit.
  * Score: `-0.1423` (where `0.0` is a perfect match).
  * Evaluation: $-0.1423 \ge -5.0$.
* **Output**: Grounding check passes (`hasContext = true`).

#### Step 7: SQLite DB Metadata Seek
* **Action**: The system queries SQLite using the matching `faiss_id` to retrieve translation segments.
* **SQL Query**:
  ```sql
  SELECT * FROM chunks WHERE faiss_id = 1042;
  ```
* **Output**: SQLite executes a B-Tree search and returns the metadata row. Since the user's source language is `"hi-IN"` (Hindi), the system parses the `translations` column JSON object (`translations.hi`) and retrieves the Hindi translation text:
  * `text`: `"भारत की राजधानी नई दिल्ली है। यह एक ऐतिहासिक शहर है जिसमें लाल किला और इंडिया गेट..."`

#### Step 8: Contextual LLM Streaming
* **Action**: The system formats the prompt for the Mistral model:
  ```
  Context:
  [Source 1]: भारत की राजधानी नई दिल्ली है। यह एक ऐतिहासिक शहर है जिसमें लाल किला और इंडिया गेट...

  User Language: hi-IN
  ```
* **Output**: The LangChain `ChatMistralAI` model receives the system instructions and streams the response tokens back to the UI in Hindi:
  * Chunks: `"भारत "` ➡️ `"की "` ➡️ `"राजधानी "` ➡️ `"नई "` ➡️ `"दिल्ली "` ➡️ `"है।"`

---

## ⚡ Latency Sweep Benchmarks (97,941 Queries)
An offline sweep benchmark was executed against the full **97,941 query** Hindi dataset (`hinval.parquet`) using native pre-allocated float arrays:

| Metric | Latency (ms) | Target Budget (ms) | Status |
| :--- | :--- | :--- | :--- |
| **P50 Latency** | **0.8308 ms** | 200.0 ms | ✅ PASSED |
| **P70 Latency** | **0.8789 ms** | 200.0 ms | ✅ PASSED |
| **P100 Latency** | **69.6232 ms** | 200.0 ms | ✅ PASSED |

---

## ✨ Features

* **⚡ Sub-Millisecond Search**: Hybrid retrieval using FAISS native HNSW index search combined with SQLite indexed metadata lookups.
* **🗣️ Voice & Text Interface**: Real-time voice query recording, transcribing, and translating automatically.
* **🔒 Strict Safety Guardrails**: Built-in input filters to block jailbreaks/exploits, and output grounding checkers to catch hallucinations.
* **🔥 Dynamic Warmup Cache**: Server boots by executing 70 random diverse query searches to warm up V8 memory, index mappings, and SQLite disk caches.
* **🌊 Real-time SSE Execution Console**: The frontend features a live execution console that displays every pipeline step, its latency, and the exact system prompt.
* **🦜 LangChain Integration**: Powered by `@langchain/mistralai`'s `ChatMistralAI` model for production-ready model streaming.

---

## 🛠️ Local Development Setup

### Prerequisites
* **Node.js**: `v24+`
* C++ Build tools (`make`, `g++`) installed on your host system if building server node modules from scratch.

### 1. Configure Server Environment
Create a `server/.env` file with your credentials:
```ini
NODE_ENV=development
PORT=5000
MISTRAL_API_KEY=your_mistral_api_key
SARVAM_API_KEY=your_sarvam_api_key
```
> [!TIP]
> You can also supply rotated backup keys in the format `MISTRAL_API_KEY2`, `MISTRAL_API_KEY3`, etc. The server will cycle through them in a round-robin rotation.

### 2. Start the Backend Server
```bash
cd server
npm install
npm run build
npm start
```
On boot, the server will log:
`[INFO] Eagerly warming up FAISS searcher and SQLite database caches...`
`[INFO] RAG searcher warmup completed successfully with 70 diverse queries.`

### 3. Start the Frontend Client
```bash
cd Client
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 🐳 Docker & Render Deployment

The repository includes a production-grade multi-stage **[`Dockerfile`](./Dockerfile)** optimized for deploying to cloud providers like Render.

### How to deploy to Render:
1. Create a new **Web Service** on Render and connect your repository.
2. Render will automatically detect the root `Dockerfile` and select the **Docker** runtime.
3. In the **Environment Variables** settings, configure:
   * `MISTRAL_API_KEY` = `your_mistral_key`
   * `SARVAM_API_KEY` = `your_sarvam_key`
   * `NODE_ENV` = `production`
4. Click **Deploy**. The container will compile all assets, copy the committed FAISS indices, warm up the database page pools, and run stably.

---

## 📁 Repository Structure
```
├── Client/                     # React Frontend App
│   ├── src/
│   │   ├── components/         # Orb visual, Source Cards, & Timeline Console
│   │   └── hooks/              # Audio recorder and RAG stream hooks
│   └── package.json
├── server/                     # Express Backend Server
│   ├── src/
│   │   ├── shared/
│   │   │   ├── controllers/    # RAG pipeline controller & warmups
│   │   │   └── utils/          # FAISS searches & LangChain connections
│   │   └── server.ts
│   └── package.json
├── indexing/                   # Index Generation Workspace
│   └── indexes/                # Committed FAISS index & SQLite DB files
└── Dockerfile                  # Production Multi-Stage Builder
```

---

## 📜 License
This project is proprietary. Developed for the HHGoa RAG search project.
