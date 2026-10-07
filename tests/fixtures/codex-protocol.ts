// Minimal response-event wire fixture derived from openai/codex@9e552e9d15ba52bed7077d5357f3e18e330f8f38.
// Source: codex-api/src/sse/responses.rs.
export const REASONING_SUMMARY_SSE = [
  "event: response.reasoning_summary_text.delta\r\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"summary\",\"summary_index\":0}\r\n\r\n",
  "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n",
  "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_usage\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":10,\"input_tokens_details\":{\"cached_tokens\":4},\"output_tokens\":7,\"output_tokens_details\":{\"reasoning_tokens\":3},\"total_tokens\":17}}}\n\n"
].join("");
