import "dotenv/config";

const apiKeys: string[] = [];

if (process.env.MISTRAL_API_KEY) {
    apiKeys.push(process.env.MISTRAL_API_KEY.trim());
}

for (let i = 2; i <= 50; i++) {
    const key = process.env[`MISTRAL_API_KEY${i}`];
    if (key && key.trim()) {
        apiKeys.push(key.trim());
    }
}

console.log(`Found ${apiKeys.length} API keys in environment. Testing...`);

async function testKey(key: string, index: number) {
    const keyName = index === 0 ? "MISTRAL_API_KEY" : `MISTRAL_API_KEY${index + 1}`;
    try {
        const response = await fetch("https://api.mistral.ai/v1/embeddings", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${key}`,
            },
            body: JSON.stringify({
                model: "mistral-embed",
                input: ["hello"],
            }),
        });

        if (response.ok) {
            console.log(`✅ [WORKING] ${keyName}: Key is working perfectly.`);
            return true;
        } else {
            const body = await response.text().catch(() => "");
            console.log(`❌ [FAILED]  ${keyName}: HTTP ${response.status} - ${body}`);
            return false;
        }
    } catch (e: any) {
        console.log(`❌ [ERROR]   ${keyName}: Network error - ${e.message}`);
        return false;
    }
}

async function run() {
    let working = 0;
    let failed = 0;
    for (let i = 0; i < apiKeys.length; i++) {
        const key = apiKeys[i];
        if (!key) continue;
        const success = await testKey(key, i);
        if (success) working++;
        else failed++;
    }
    console.log(`\n=== Summary ===`);
    console.log(`Total Keys tested: ${apiKeys.length}`);
    console.log(`Working keys:     ${working}`);
    console.log(`Failed keys:      ${failed}`);
}

run().catch(console.error);
