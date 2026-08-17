import { writeFile } from "node:fs/promises";
import { MistralAIEmbeddings } from "@langchain/mistralai";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { Document } from "@langchain/core/documents";

async function fetchRows(
    lang: string,
    split: string,
    offset = 0,
    length = 100
): Promise<any[]> {
    const url = new URL("https://datasets-server.huggingface.co/rows");
    url.searchParams.set("dataset", "ai4bharat/MSMARCO-XI");
    url.searchParams.set("config", lang);
    url.searchParams.set("split", split);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(length));

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HF API error: ${res.status} ${await res.text()}`);

    const data = (await res.json()) as { rows: any[] };

    return data.rows.map((r: any) => r.row);
}

async function fetchAllRows(lang: string, split: string): Promise<any[]> {
    const all: any[] = [];
    let offset = 0;
    const pageSize = 100;

    while (true) {
        const rows = await fetchRows(lang, split, offset, pageSize);
        if (rows.length === 0) break;
        all.push(...rows);
        offset += pageSize;
        console.log("Fetched", all.length, "rows so far");
    }

    return all;
}

async function saveJsonl(rows: any[], filepath: string) {
    const text = rows.map((row) => JSON.stringify(row)).join("\n");
    await writeFile(filepath, text, "utf-8");
    console.log("Saved to", filepath);
}

async function main() {
    const data = await fetchAllRows("te", "validation");
    await saveJsonl(data, "telval.jsonl");

    // check data[0] to confirm the actual field name before running at scale
    const docs = data.map(
        (row, i) =>
            new Document({
                pageContent: row.query ?? JSON.stringify(row),
                metadata: { row_index: i, ...row },
            })
    );

    const embeddings = new MistralAIEmbeddings({
        apiKey: process.env.MISTRAL_API_KEY || "",
        model: "mistral-embed",
    });

    const pinecone = new PineconeClient(); // reads PINECONE_API_KEY from env
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX!);

    await PineconeStore.fromDocuments(docs, embeddings, {
        pineconeIndex,
        maxConcurrency: 5,
        // namespace: "msmarco-xi-te",
    });

    console.log("Indexed", docs.length, "documents into Pinecone");

    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
        pineconeIndex,
    });
    const results = await vectorStore.similaritySearch("your search query here", 5);
    console.log(results);
}

main();


/*q


Langchain/textsplot 

splitter = new RecursiveCharacterTextSplitter({
    chunk_size: 1000,
    chunk_overlap: 200,
});

splitter.splitext(data )


*/