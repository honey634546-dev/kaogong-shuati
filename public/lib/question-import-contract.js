/** Keep useful subtype information in the existing import category field. */
export const QUESTION_IMPORT_CLASSIFICATION_HINT = `题目分类补充约定：category 可以保存“大类/细类”路径。原文明确标注图形推理、定义判断、类比推理或逻辑判断时，保留为“判断推理/对应细类”，不要只留下“判断推理”。原文未标注但题面结构足够明确时，也可使用该细类；不确定细类时保留“判断推理”，不要强猜。其他大类沿用原分类。题型标题从题干中移除前，先将其分类信息保存到 category；不可把试卷总说明中列举的所有题型当作每道题的分类。不得为了分类补写缺失题干、图片、材料或答案。`;

export function createQuestionImportAgent(agent) {
  if (!agent) return agent;
  return { ...agent, system_prompt: `${agent.system_prompt || ''}\n\n${QUESTION_IMPORT_CLASSIFICATION_HINT}` };
}
