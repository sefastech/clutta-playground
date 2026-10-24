import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

// The fixture exercises the real graph and tool path. It is never called a live LLM.
export function fixtureModel(orderId) {
  return {
    bindTools() { return this; },
    async invoke(messages) {
      const result = messages.findLast((message) => message instanceof ToolMessage);
      if (!result) return new AIMessage({ content: '', tool_calls: [{ name: 'lookup_order', args: { order_id: orderId }, id: 'fixture-order-lookup', type: 'tool_call' }] });
      const order = JSON.parse(result.content);
      return new AIMessage(`Your order has ${order.status}. It is expected to arrive ${order.arrival}.`);
    },
  };
}

export async function runAgent({ store, requestId, model, modelMode, emit = () => {} }) {
  const request = await store.getRequest(requestId);
  if (!request) throw new Error('Unknown lab request.');
  const existing = await store.answerFor(requestId);
  if (existing) return existing; // No duplicate model cost or outbox entry on completed-request replay.
  const lookup = tool(async ({ order_id }) => {
    if (order_id !== request.order_id) throw new Error('Tool access is limited to this request\'s synthetic order.');
    const order = await store.lookupOrder(order_id);
    if (!order) throw new Error('Synthetic order not found.');
    return JSON.stringify(order);
  }, { name: 'lookup_order', description: 'Look up the requested synthetic order before answering.', schema: z.object({ order_id: z.string() }) });
  const bound = model.bindTools([lookup]);
  const State = Annotation.Root({
    messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
    lookedUp: Annotation({ default: () => false }),
    answer: Annotation(),
  });
  const graph = new StateGraph(State)
    .addNode('reason', async (state) => ({ messages: [await bound.invoke([
      new SystemMessage('Use lookup_order for the requested order. Answer briefly using its result. Do not claim that a message was delivered.'),
      ...state.messages,
    ])] }))
    .addNode('tools', async (state) => {
      const results = [];
      for (const call of state.messages.at(-1).tool_calls ?? []) {
        if (call.name !== 'lookup_order') throw new Error('Unknown tool.');
        results.push(new ToolMessage({ content: await lookup.invoke(call.args), tool_call_id: call.id }));
      }
      return { messages: results, lookedUp: results.length > 0 || state.lookedUp };
    })
    .addNode('persist_answer', async (state) => {
      if (!state.lookedUp) throw new Error('Final answer has no successful order lookup.');
      const content = state.messages.at(-1).content;
      const text = typeof content === 'string' ? content : content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
      if (!text.trim() || text.length > 4096) throw new Error('Answer must fit one Telegram text message.');
      const answer = await store.persistAnswer(requestId, text, modelMode);
      emit('agent', 'answer.persisted', { ...request, ...answer }, { timestamp: answer.created_at.toISOString() });
      return { answer };
    })
    .addEdge(START, 'reason')
    .addConditionalEdges('reason', (state) => state.messages.at(-1).tool_calls?.length ? 'tools' : 'persist_answer')
    .addEdge('tools', 'reason')
    .addEdge('persist_answer', END)
    .compile();
  return (await graph.invoke({ messages: [new HumanMessage(`Where is my order #${request.order_id}?`)] }, { recursionLimit: 10 })).answer;
}
