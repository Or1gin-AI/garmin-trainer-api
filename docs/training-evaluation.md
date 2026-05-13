# Training Evaluation Feature Handoff

## 背景

训练评价功能用于让用户把某一天实际完成的 Garmin 运动记录，明确绑定到 Garmin Trainer 生成的训练计划上，然后由平台对「当天计划」和「当天实际训练」做对比评价。

当前版本已经完成产品入口、数据结构、接口闭环和占位评价结果。具体评价内容、评价模型和教练反馈文案还没有实现，需要后续补齐。

## 用户流程

1. 用户进入前端日历页 `/calendar`。
2. 日历默认展示今天前后 30 天，一次展示一个完整月份。
3. 用户先把某个训练计划应用到日历。当前逻辑会从今天起，把计划按 7 天课表循环应用到未来 30 天。
4. 日历每天会同时展示：
   - 计划训练：来自当前应用中的 Garmin Trainer 训练计划。
   - 实际运动：来自用户 Garmin 国区和国际区账号的活动记录。
   - 评价状态：如果当天已经提交过评价，会显示「评价」标记。
5. 用户点击某一天，在右侧/下方详情区看到当天计划和当天 Garmin 运动记录。
6. 用户勾选一条或多条当天实际运动，点击「生成评价」。
7. 后端保存这次评价请求，并返回一个 `ready` 状态的占位结果。
8. 前端展示评价结果卡片。

## 当前已经实现

### 前端

相关文件：

- `garmin-trainer-web/src/app/(app)/calendar/page.tsx`
- `garmin-trainer-web/src/lib/api.ts`

当前页面能力：

- 月视图日历。
- 今天前后 30 天范围。
- 每天格子展示计划训练数量、Garmin 记录数量、评价状态。
- 选择某一天后展示：
  - 当天训练计划。
  - 当天 Garmin 实际运动。
  - 勾选 Garmin 运动记录的控件。
  - 「生成评价」按钮。
  - 已生成的评价结果卡片。
- 调用 `createTrainingEvaluation()` 提交评价。

当前前端 API 类型：

```ts
export interface TrainingEvaluationSummary {
  id: string;
  date: string;
  planId: string | null;
  plannedWorkoutIds: string[];
  activityRefs: Array<{ region: GarminRegion | 'manual'; activityId: string }>;
  status: 'pending' | 'ready' | 'failed';
  result: {
    title: string;
    summary: string;
    plannedWorkoutCount: number;
    activityCount: number;
  } | null;
  note: string | null;
  createdAt: string;
}
```

### 后端

相关文件：

- `src/routes/training.ts`
- `src/db/schema.ts`
- `src/garmin/fetch-recent.ts`
- `drizzle/0007_training_evaluations.sql`

当前接口：

#### 获取训练日历

```http
GET /api/training/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
```

返回内容包含：

- `calendar.activePlan`：当前应用到日历的训练计划。
- `calendar.activitySources`：国区/国际区 Garmin 活动读取状态。
- `events`：计划训练和 Garmin 实际运动混合列表。
- `evaluations`：日期范围内已有训练评价。

默认日期范围：

- `from`：今天前 30 天。
- `to`：今天后 30 天。

最大查询跨度：

- 120 天。

#### 创建训练评价

```http
POST /api/training/calendar/evaluations
Content-Type: application/json

{
  "date": "2026-05-13",
  "activityRefs": [
    { "region": "cn", "activityId": "123456789" },
    { "region": "global", "activityId": "987654321" }
  ],
  "note": "optional user note"
}
```

当前校验规则：

- 用户必须已登录。
- 必须存在当前应用到日历的训练计划，否则返回 `409 no_active_training_plan`。
- `date` 必须是 `YYYY-MM-DD`。
- `activityRefs` 至少 1 条，最多 12 条。
- 后端会重新读取当天 Garmin 活动，并校验用户提交的 activity 是否真的存在于当天活动列表中。
- 如果提交了不存在的活动，返回 `400 invalid_activity_selection`。

当前返回：

```json
{
  "evaluation": {
    "id": "...",
    "date": "2026-05-13",
    "planId": "...",
    "plannedWorkoutIds": ["..."],
    "activityRefs": [
      { "region": "cn", "activityId": "123456789" }
    ],
    "status": "ready",
    "result": {
      "title": "训练评价已生成",
      "summary": "已记录这一天的实际运动，并与当天训练计划建立对比关系。详细评价模型稍后接入。",
      "plannedWorkoutCount": 1,
      "activityCount": 1
    },
    "note": null,
    "createdAt": "..."
  }
}
```

## 数据模型

表：`training_evaluation`

字段：

- `id`：评价记录 ID。
- `user_id`：用户 ID。
- `plan_id`：评价发生时的当前日历计划。计划删除后允许置空。
- `evaluation_date`：评价对应的日期。
- `planned_workout_ids`：当天计划训练 ID 列表。
- `activity_refs`：用户选择的实际运动引用。
- `status`：`pending`、`ready`、`failed`。
- `result`：评价结果 JSON。当前是占位结构。
- `note`：用户备注。当前前端还没有输入框。
- `created_at` / `updated_at`：时间戳。

当前 activity 引用结构：

```ts
Array<{
  region: 'cn' | 'global' | 'manual';
  activityId: string;
}>
```

注意：schema 预留了 `manual`，但当前后端会校验 activity 必须来自当天 Garmin 活动列表，所以前端暂时不要提交 `manual`。

## 当前评价逻辑

入口函数：

```ts
buildEvaluationPlaceholder(plannedWorkoutIds, activityRefs)
```

当前它只返回占位内容：

```ts
{
  title: '训练评价已生成',
  summary: '已记录这一天的实际运动，并与当天训练计划建立对比关系。详细评价模型稍后接入。',
  plannedWorkoutCount: plannedWorkoutIds.length,
  activityCount: activityRefs.length,
}
```

也就是说，现在系统已经能回答：

- 用户评价的是哪一天。
- 当天计划里有哪些训练。
- 用户实际选择了哪些 Garmin 活动。
- 这次评价记录是否已生成。

但系统还不能真正回答：

- 训练是否完成到位。
- 强度是否过高或过低。
- 配速、心率、功率是否符合计划。
- 训练负荷是否合理。
- 对下一次训练有什么建议。

这些内容需要后续补齐。

## 后续要补的核心内容

建议把真实评价逻辑封装成一个独立函数，例如：

```ts
async function generateTrainingEvaluation(input: {
  userId: string;
  date: string;
  plan: TrainingPlan;
  plannedWorkouts: Workout[];
  selectedActivities: CalendarEvent[];
  note?: string | null;
}): Promise<TrainingEvaluationResult>
```

然后在 `POST /api/training/calendar/evaluations` 里替换当前的 `buildEvaluationPlaceholder()`。

建议结果结构由同事进一步定稿，但可以从下面这个方向开始：

```ts
interface TrainingEvaluationResult {
  title: string;
  summary: string;
  score?: number; // 0-100
  verdict?: 'matched' | 'under_done' | 'over_done' | 'different_sport' | 'missed' | 'recovery_needed';
  plannedWorkoutCount: number;
  activityCount: number;
  adherence?: {
    sportMatched: boolean;
    durationRatio?: number;
    distanceRatio?: number;
    intensityMatched?: boolean;
    completedMainSet?: boolean | null;
  };
  load?: {
    planned?: number | null;
    actual?: number | null;
    comment?: string;
  };
  intensity?: {
    planned?: string | null;
    actual?: string | null;
    comment?: string;
  };
  highlights?: string[];
  risks?: string[];
  suggestions?: string[];
  nextWorkoutAdjustment?: string | null;
}
```

需要同事补完的内容：

- 评价维度：
  - 完成度。
  - 运动类型匹配。
  - 时长/距离匹配。
  - 强度匹配。
  - 心率、功率、配速是否合理。
  - 训练负荷是否偏高或偏低。
  - 多运动合并时怎么评价。
- 评价规则：
  - 什么算完成。
  - 什么算过量。
  - 什么算训练类型不匹配。
  - 恢复日做了高强度运动时怎么提示。
  - 没有计划但有实际运动时怎么评价。
  - 有计划但没有实际运动时是否允许生成评价。
- 文案风格：
  - 要像教练、数据分析师，还是轻量鼓励型助手。
  - 是否需要给出下一次训练调整建议。
- 是否接入 AI：
  - 纯规则引擎。
  - 规则引擎 + LLM 生成自然语言。
  - LLM 直接基于结构化数据生成评价。

## 推荐实现路线

### 第一步：先做规则评价

先不要急着接 LLM，建议先落一个稳定的规则层。

规则层负责输出结构化判断，例如：

- `sportMatched`
- `durationRatio`
- `distanceRatio`
- `intensityMatched`
- `loadDelta`
- `verdict`

这样前端和数据结构稳定，不会被模型文案波动影响。

### 第二步：再接自然语言总结

当规则层稳定后，再把结构化评价交给 LLM 生成 `summary`、`highlights`、`risks`、`suggestions`。

推荐保留结构化字段，不要只存一段自然语言。原因是后续可以做：

- 趋势统计。
- 周报/月报。
- 训练完成率。
- 疲劳风险提示。
- 计划自动调整。

### 第三步：支持异步评价

当前接口是同步返回 `ready`。如果后续接 LLM 或更复杂的数据读取，建议改为：

1. 创建记录时写入 `pending`。
2. worker 异步生成评价。
3. 成功后写入 `ready + result`。
4. 失败后写入 `failed`。
5. 前端轮询或刷新日历获取结果。

当前数据库已经支持 `pending` / `ready` / `failed` 三种状态。

## 重要边界条件

同事补实现时要特别注意这些情况：

- 用户没有应用训练计划：当前不能评价。
- 当天没有 Garmin 活动：当前前端不能提交。
- Garmin 国区或国际区读取失败：日历会返回 `activitySources` 中的错误，前端会展示提示。
- 用户有多个 Garmin 活动：前端允许多选，后端会一起存入 `activityRefs`。
- 用户同时连接国区和国际区：活动会按签名去重，但 `region` 仍会保留。
- 用户重复提交同一天评价：当前允许创建多条评价记录，没有做唯一约束。
- 用户换了 active plan 后再评价同一天：新评价会绑定提交时的 active plan。
- 计划训练是按 7 天周期展开到未来日期，不是每一天都有单独持久化计划项。

## 需要考虑但尚未实现

- 删除某条训练评价。
- 修改某条训练评价选择的活动。
- 自动推荐当天应该选择哪几条活动。
- 没有 Garmin 活动时允许用户手动补录。
- 对没有计划的自由训练生成评价。
- 对有计划但没有实际训练的 missed workout 生成评价。
- 将评价结果用于下一周期训练计划调整。
- 评价详情页。
- 周度汇总。
- 按计划维度查看所有评价。

## 前端继续完善点

建议后续改动位置：

- 页面：`garmin-trainer-web/src/app/(app)/calendar/page.tsx`
- API 类型：`garmin-trainer-web/src/lib/api.ts`

可补功能：

- 给评价增加备注输入框。
- 评价结果卡片展示更丰富字段。
- 对 `pending` 状态增加加载中样式。
- 对 `failed` 状态增加重试按钮。
- 支持删除评价。
- 同一天多条评价时，考虑是否折叠或展示最新一条。

如果 `TrainingEvaluationResult` 扩展了字段，前端 `TrainingEvaluationSummary.result` 类型也要同步更新。

## 后端继续完善点

建议后续改动位置：

- 路由：`src/routes/training.ts`
- 评价生成服务：建议新建 `src/training/evaluation.ts`
- 数据结构：`src/db/schema.ts`
- 迁移：需要修改 result 结构时通常不需要迁移；如果加列或唯一约束，需要新增 Drizzle migration。

建议把下面逻辑从路由里拆出去：

- 加载当天计划训练。
- 加载并校验用户选择的 Garmin 活动。
- 生成结构化评价。
- 写入评价记录。

这样后续接 worker 或 LLM 会更容易。

## 验收标准

同事补完具体评价内容后，至少要满足：

- 用户选择当天活动后，能看到非占位评价内容。
- 评价内容能明确说出当天计划和实际运动的差异。
- 多活动选择时不会丢数据。
- 国区/国际区活动都能被正确引用。
- 无 active plan、无 activity、非法 activity 都有明确错误。
- 刷新日历后，已生成评价仍能展示。
- 前端类型、后端类型、数据库存储结构一致。

## 测试建议

### API

- `GET /api/training/calendar` 未登录返回 401。
- 无 active plan 时创建评价返回 `409 no_active_training_plan`。
- 提交不存在的 activity 返回 `400 invalid_activity_selection`。
- 提交当天真实 activity 后返回评价记录。
- `GET /api/training/calendar` 能读回刚创建的评价。
- 国区和国际区活动都能通过校验。

### Web

- 日历能显示计划和 Garmin 活动。
- 勾选一条活动后，「生成评价」按钮可用。
- 提交成功后显示评价卡片。
- 切换日期会清空当前选择。
- Garmin 活动读取失败时页面有提示。

## 当前上线状态

当前生产环境已经包含训练评价入口和占位结果：

- Web：`https://garmin-trainer.uk/calendar`
- API：`https://api.garmin-trainer.uk/api/training/calendar`

后续同事主要要做的是：把当前占位评价替换成真正的训练评价内容生成逻辑。
