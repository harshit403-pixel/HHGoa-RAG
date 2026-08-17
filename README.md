# RAG in Goa

> A voice-enabled Retrieval-Augmented Generation system that lets users ask questions naturally and receive grounded answers from the AI4Bharat MSMARCO-XI dataset.

Built for **HH Goa 2026 — Shortlisting Task 2**.

---

## Overview

RAG in Goa is a voice-first Retrieval-Augmented Generation (RAG) system.

Instead of typing a question, the user simply speaks. The system captures the voice, detects when the user has finished speaking, converts the speech into text, retrieves relevant information from the provided dataset, generates a grounded response, and presents the answer along with its retrieved context.

### Pipeline

```text
Voice Input
     │
     ▼
Speech Detection
     │
     ▼
Speech-to-Text
     │
     ▼
Query Processing
     │
     ▼
Vector Retrieval
     │
     ▼
Reranking / Context Selection
     │
     ▼
Answer Generation
     │
     ▼
Grounding / Guardrails
     │
     ▼
Answer + Sources
