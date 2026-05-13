# Training Evaluation Feature Handoff

## Purpose

训练评价功能让用户选择某一天的 Garmin 实际运动记录，并把这些记录绑定到 Garmin Trainer 当天的计划训练上。平台随后可以比较「计划」和「实际执行」，生成训练评价。

当前版本完成了入口、数据闭环和占位结果；真实评价模型仍需要继续完善。

## User Flow

1. 用户进入训练日历。
2. 日历展示当天前后 30 天，并在每一天显示计划训练和 Garmin 实际活动。
3. 用户点击某一天，查看当天计划和 Garmin 活动。
4. 用户勾选一条或多条当天活动。
5. 用户提交训练评价。
6. 后端保存评价记录，并返回当前占位评价。
7. 前端显示评价状态和评价结果卡片。

## Implemented Pieces

### Backend

核心位置：

- `src/routes/training.ts`
- `src/db/schema.ts`

接口：

```http
GET /api/training/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
POST /api/training/calendar/evaluations
```

`GET /api/training/calendar` 返回：

- 当前应用到日历的训练计划。
- 展开后的计划训练事件。
- Garmin 国区/国际区实际活动事件。
- 已提交的训练评价记录。
- Garmin 活动读取状态。

`POST /api/training/calendar/evaluations` 输入：

```json
{
  "date": "2026-05-13",
  "activityRefs": [
    { "region": "cn", "activityId": "123456789" }
  ],
  "note": "optional note"
}
```

当前后端校验：

- 用户必须登录。
- 必须有 active calendar plan。
- `date` 必须是 `YYYY-MM-DD`。
- `activityRefs` 至少 1 条，最多 12 条。
- 后端会重新读取当天 Garmin 活动，确认用户提交的 activity 确实属于当天。

当前评价结果仍是占位结构：

```ts
{
  title: string;
  summary: string;
  plannedWorkoutCount: number;
  activityCount: number;
}
```

### Frontend

核心位置：

- `garmin-trainer-web/src/app/(app)/calendar/page.tsx`
- `garmin-trainer-web/src/lib/api.ts`

当前能力：

- 月视图日历。
- 每天展示计划训练和 Garmin 活动。
- 日期详情中允许用户选择当天实际运动。
- 提交后显示评价结果。
- 已评价日期会显示评价状态。

## Data Model

表：`training_evaluation`

核心字段：

- `id`
- `user_id`
- `plan_id`
- `evaluation_date`
- `planned_workout_ids`
- `activity_refs`
- `status`
- `result`
- `note`
- `created_at`
- `updated_at`

`activity_refs` 结构：

```ts
Array<{
  region: 'cn' | 'global' | 'manual';
  activityId: string;
}>
```

当前虽然 schema 预留了 `manual`，但接口仍要求 activity 来自 Garmin 当天活动列表。

## Remaining Product Work

需要同事继续补完真实评价逻辑，建议拆成独立服务，例如：

```ts
async function generateTrainingEvaluation(input: {
  userId: string;
  date: string;
  plannedWorkouts: Workout[];
  selectedActivities: CalendarEvent[];
  note?: string | null;
}): Promise<TrainingEvaluationResult>
```

建议评价维度：

- 运动类型是否匹配计划。
- 训练时长/距离完成度。
- 心率、配速、功率是否符合目标。
- Garmin training load 是否明显偏高或偏低。
- 恢复日是否做了过强训练。
- 多条活动如何合并评价。
- 是否需要调整下一次训练。

建议结果结构：

```ts
interface TrainingEvaluationResult {
  title: string;
  summary: string;
  score?: number;
  verdict?: 'matched' | 'under_done' | 'over_done' | 'different_sport' | 'missed' | 'recovery_needed';
  plannedWorkoutCount: number;
  activityCount: number;
  adherence?: {
    sportMatched: boolean;
    durationRatio?: number;
    distanceRatio?: number;
    intensityMatched?: boolean;
  };
  load?: {
    planned?: number | null;
    actual?: number | null;
    comment?: string;
  };
  highlights?: string[];
  risks?: string[];
  suggestions?: string[];
}
```

## Suggested Implementation Path

1. 先做规则引擎，输出结构化评价字段。
2. 再把结构化结果交给 LLM 生成自然语言总结。
3. 保留结构化字段，方便后续做周报、完成率、趋势分析和计划自动调整。
4. 如果评价生成变慢，把接口改成 `pending -> ready/failed` 的异步 worker 流程。

## Edge Cases

- 没有 active plan：当前返回 `409 no_active_training_plan`。
- 当天没有 Garmin 活动：前端不能提交。
- 用户同一天选择多条活动：后端保存完整 `activityRefs`。
- 国区/国际区同时存在：活动按当前日历逻辑展示，评价记录保留 region。
- 同一天重复提交：当前允许多条评价记录。
- 计划被删除：评价的 `plan_id` 允许置空。

## Acceptance Checklist

- 能从日历选择 Garmin 活动并生成评价记录。
- 刷新后评价仍能展示。
- 非法 activity 不能提交。
- 国区/国际区 activity 都能引用。
- 真实评价上线后，结果能说明计划和实际训练的差异。
- 前端类型、后端返回和数据库结构保持一致。
