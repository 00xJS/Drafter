// What the assistant says about itself.
//
// Asked "What all can you do?", the chat answered that it didn't have that
// information in the records: everything it was given was the planner, nothing
// about itself, and it is told to say so when the records don't hold an
// answer. A question about the assistant is now answered here, at once and the
// same way every time, without a model call; one these patterns miss still
// reaches the model, which is told what it can do (buildChatPrompt).

/** The chat's own answer to "what can you do?". Kept true to chatactions.ts: the seven kinds of change, the journal left out. */
export const CHAT_HELP = [
  'Here’s what I can do:',
  '• Answer questions about your planner: tasks, the calendar, people and places, meals and recipes, bills and clothes.',
  '• Suggest changes you apply with a tap: add a task, move or finish one, add to the grocery list, plan a meal, log a visit, save a note or add a calendar event.',
  '• Answer general questions too, like cooking times or conversions. Those are marked as general, since they don’t come from your planner.',
  'I can’t read your journal here, send messages, or change anything until you tap Apply.',
  'Try “What’s due tomorrow?”, “Add milk and eggs to the grocery list” or “Plan tacos for Tuesday dinner”.',
].join('\n')

/** Ask's, which finds and answers but changes nothing: one paragraph, as its answer is drawn. */
export const ASK_HELP =
  'Ask looks through your planner — tasks, the calendar, people and places, meals, bills and clothes, and your journal when you switch it on — and answers from what it finds. To add or change something, or to ask a general question, use the chat: the speech bubble at the top.'

/** The line under an answer the model gave from general knowledge rather than from the planner. */
export const GENERAL_LABEL = 'General answer, not from your planner.'

/** Words around a question that don't change what it asks: a greeting before it, "for me" after it. */
const LEADING = /^(?:hi|hey|hello|ok|okay|so|um|yo|drafter|please)\s+/
const TRAILING = /\s+(?:for me|for us|here|exactly|again|please|today|drafter|then)$/

/**
 * Questions about the assistant itself, whole: "help me plan tacos" is a
 * request, not a question about help, so every pattern is anchored at both
 * ends of what was asked.
 */
const ABOUT_ITSELF: RegExp[] = [
  /^what (?:all |else |exactly |(?:kinds? |sorts? )?(?:of )?things )?(?:can|could|do) (?:you|drafter|it) (?:do|help(?: me| us)?(?: with)?|handle|offer)$/,
  /^what (?:all |else )?(?:can|could|should) (?:i|we) (?:ask|say|tell|type)(?: to)?(?: you| drafter| it)?(?: to do)?$/,
  /^what (?:can|could) (?:i|we) use (?:you|drafter|this|it|the chat|the assistant) (?:for|to do)$/,
  /^what are you (?:able to do|good at|good for|capable of|for|here for)$/,
  /^what (?:are|is) (?:your|drafter[’']?s) (?:capabilities|features|abilities|skills|commands|functions)$/,
  /^(?:how )?(?:can|could|will|do) you help(?: me| us)?$/,
  /^how (?:does|do) (?:this|it|you|drafter|the chat|this chat|the assistant|this assistant) work$/,
  /^how (?:do|can|should) (?:i|we) use (?:this|you|it|drafter|the chat|this chat|the assistant|this app)$/,
  /^(?:help|help me|i need help|need help|help please)$/,
  /^(?:who|what) are you$/,
  /^what is (?:this|drafter|the assistant)$/,
  /^(?:tell me|show me|list) (?:what you can do|what you do|your (?:capabilities|features|commands)|about yourself|about you)$/,
  /^(?:capabilities|features|commands|examples)$/,
]

/**
 * A question as the patterns read it: lower case, contractions opened and
 * punctuation gone — then again with each greeting or "for me" peeled off,
 * since "What is Drafter?" and "What can you do, Drafter?" both end in a name.
 */
function readings(question: string): string[] {
  let q = question
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\bwhat'?s\b/g, 'what is')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const out: string[] = []
  for (let before = ''; q && before !== q; ) {
    out.push(q)
    before = q
    q = q.replace(LEADING, '').replace(TRAILING, '').trim()
  }
  return out
}

/** Whether this is a question about the assistant itself rather than about the planner. */
export function isHelpQuestion(question: string): boolean {
  return readings(question).some(q => ABOUT_ITSELF.some(re => re.test(q)))
}
