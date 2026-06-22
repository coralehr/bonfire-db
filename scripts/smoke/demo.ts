interface HealthResponse {
  ok: boolean;
  service: string;
}

const healthUrl = process.env.BONFIRE_API_URL ?? "http://127.0.0.1:8080/health";
const attempts = 20;
const delayMs = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let lastError: unknown;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) {
      throw new Error(`health endpoint returned ${response.status}`);
    }

    const body = (await response.json()) as HealthResponse;
    if (body.ok !== true || body.service !== "bonfire-api") {
      throw new Error(`unexpected health payload: ${JSON.stringify(body)}`);
    }

    console.log(`smoke:demo PASS ${healthUrl}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < attempts) await sleep(delayMs);
  }
}

console.error(`smoke:demo FAIL ${String(lastError)}`);
process.exit(1);
