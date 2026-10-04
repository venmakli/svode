#!/bin/sh
# A scripted ACP agent with one representative turn, for `live_turn --record`:
# streamed reasoning and messages, grouped tool calls with updates, a plan
# replaced in place, an unknown update, repeated errors and a permission
# for a tool call that the client answers.
#
# cargo run -p svode-agents --example live_turn -- --agent scripted \
#   --prompt "Fix the build" --on-pending allow_once --record turn.json \
#   -- /bin/sh crates/svode-agents/examples/scripted_turn_agent.sh
update() {
  printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":%s}}\n' "$1"
}
while IFS= read -r line; do
  id=${line#*'"id":'}; id=${id%%[,\}]*}
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"agentInfo":{"name":"scripted","version":"1.0.0"}}}\n' "$id";;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"s1"}}\n' "$id";;
    *'"method":"session/prompt"'*)
      update '{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Reading the build "}}'
      update '{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"output first."}}'
      update '{"sessionUpdate":"plan","entries":[{"content":"Run the build","priority":"high","status":"in_progress"},{"content":"Fix the error","priority":"medium","status":"pending"}]}'
      update '{"sessionUpdate":"tool_call","toolCallId":"call_build","title":"cargo build","kind":"execute","status":"in_progress"}'
      update '{"sessionUpdate":"tool_call_update","toolCallId":"call_build","status":"failed","content":[{"type":"content","content":{"type":"text","text":"error[E0425]: cannot find value `x`"}}]}'
      update '{"sessionUpdate":"tool_call","toolCallId":"call_read","title":"Read src/main.rs","kind":"read","status":"completed","content":[{"type":"content","content":{"type":"text","text":"fn main() { println!(\"{}\", x); }"}}]}'
      update '{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"The build fails on an "}}'
      update '{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"undefined value."}}'
      update '{"sessionUpdate":"future_update","anything":true}'
      update '{"sessionUpdate":"tool_call","toolCallId":"call_edit","title":"Edit src/main.rs","kind":"edit","status":"pending","content":[{"type":"diff","path":"src/main.rs","oldText":"fn main() { println!(\"{}\", x); }","newText":"fn main() { let x = 1; println!(\"{}\", x); }"}]}'
      printf '{"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"call_edit","title":"Edit src/main.rs","kind":"edit","status":"pending"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}\n'
      prompt=$id
      IFS= read -r answer
      update '{"sessionUpdate":"tool_call_update","toolCallId":"call_edit","status":"completed"}'
      update '{"sessionUpdate":"plan","entries":[{"content":"Run the build","priority":"high","status":"completed"},{"content":"Fix the error","priority":"medium","status":"completed"}]}'
      update '{"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"type":"text","text":"Fixed: `x` is defined now."}}'
      update '{"sessionUpdate":"session_info_update","title":"Fix the build"}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$prompt";;
  esac
done
