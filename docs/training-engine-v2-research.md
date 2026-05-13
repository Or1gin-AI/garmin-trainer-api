# Training Engine V2 Research Spec

本文档是 Garmin Trainer 训练计划生成器的研究规格，不是产品文案。目标是把“训练科学”拆成可以实现、可以测试、可以解释的规则：每条规则都要说明采用依据、计算方式、适用边界和代码落点。

## 0. 设计原则

1. 不用单一指标判断用户能力。VO2max、FTP、Garmin Training Load、最快配速都不能单独决定训练计划。
2. 训练引擎优先避免明显不合理的计划，再追求个性化和进取性。
3. 文献有争议的指标只做风险信号，不做硬性结论。例如 ACWR、10% rule、FTP 20 分钟测试。
4. 每个推断都带 `confidence` 和 `source`，前端要能解释“为什么这么判断”。
5. LLM 只能在规则边界内选择表达和小幅变体，不能越过容量、恢复和强度约束。

证据等级：

- A: meta-analysis / systematic review / position stand / consensus
- B: controlled trial / validated model / cohort evidence
- C: expert framework / coaching practice, supported by physiology but not直接验证为单一规则
- D: Garmin 或产品代理指标；可用但必须保守

## 1. 用户能力评估 `training-capacity.ts`

### 1.1 输出对象

```ts
export interface TrainingCapacity {
  generatedAt: string;
  lookbackDays: 56;
  overall: OverallCapacity;
  load: LoadCapacity;
  recovery: RecoveryCapacity;
  sports: {
    running: SportCapacity;
    cycling: SportCapacity;
    swimming: SportCapacity;
  };
  guardrails: CapacityGuardrails;
}
```

`overall.level` 不是传统“水平等级”，而是计划生成中的风险档：

```ts
type CapacityLevel = 'novice' | 'developing' | 'trained' | 'advanced';
type Readiness = 'green' | 'yellow' | 'red';
type Confidence = 'low' | 'medium' | 'high';
```

### 1.2 历史容量

采用指标：

- 最近 7 / 28 / 56 天训练分钟数
- 最近 7 / 28 / 56 天 Garmin trainingLoad
- 每周训练频率
- 每个项目最近最长训练、P80、P90 单次时长
- 每个项目 hard sessions 数量

计算：

```ts
weeklyMinutes = groupByWeek(activities).sum(durationMin)
chronicWeeklyMinutes = median(last4To8Weeks.weeklyMinutes)
acuteWeeklyMinutes = sum(last7Days.durationMin)

if Garmin trainingLoad exists:
  dailyLoad = sum(trainingLoad per day)
else:
  dailyLoad = sum(durationMin * intensityWeight)
```

fallback intensity weights:

```ts
recovery: 0.5
low: 1.0
moderate: 2.0
high: 3.0
unknown: 1.0
```

依据和取舍：

- Banister 的 TRIMP / fitness-fatigue 模型提供“训练刺激随时间累积并衰减”的基础思想，但我们没有完整 HR time-in-zone 和个人化参数，因此不直接实现经典 impulse-response 模型。
- Foster 1998 提出用 session load、monotony、strain 监控训练压力；我们用它做风险识别，不做医学诊断。
- Garmin trainingLoad 是设备代理指标，只在同一用户内部看趋势，不跨用户比较。

参考：

- Foster 1998, Monitoring training in athletes with reference to overtraining syndrome.
- Banister fitness-fatigue / TRIMP model.

### 1.3 急慢性负荷和风险灯

计算：

```ts
acuteChronicRatio = acute7dLoad / (chronic28dLoad / 4)
```

规则：

```ts
if chronic28dLoad is missing or too small:
  acuteChronicRatio = null

if ratio > 1.5:
  add yellow/red risk signal
if ratio < 0.5 and user asks for aggressive plan:
  add detraining / low continuity signal
```

注意：ACWR 不作为单独硬规则。

原因：

- Gabbett 2016 将 ACWR 推广为 injury-risk monitoring 工具。
- Impellizzeri 等人指出 ACWR 存在方法学问题，不能把“安全区”机械当作因果规则。

实现取舍：

- 采用 `acuteChronicRatio` 作为 `riskSignals[]`。
- 不写“0.8-1.3 必然安全”。
- 最终 readiness 必须综合睡眠、HRV、伤病、历史最长训练、近期 hard stimulus。

参考：

- Gabbett 2016, The training-injury prevention paradox.
- Impellizzeri et al. 2020, ACWR methodological concerns.

### 1.4 Monotony / strain

计算：

```ts
monotony = mean(last7DailyLoad) / stddev(last7DailyLoad)
strain = sum(last7DailyLoad) * monotony
```

规则：

```ts
if validDailyLoadDays < 4:
  monotony = null

if monotony is high relative to user's own 56d baseline:
  add risk signal: load_monotony_high
```

初版 fallback:

```ts
monotony > 2.0 => yellow signal
monotony > 2.5 => red signal only if load is also elevated
```

取舍：

- Foster 的 monotony/strain 是监控框架，不是 universally validated threshold。
- 因此优先用用户自己的历史分位数；历史不足时才用保守 fallback。

参考：

- Foster 1998.

## 2. 每个项目的 `SportCapacity`

```ts
export interface SportCapacity {
  available: boolean;
  confidence: Confidence;
  recent: {
    sessions28d: number;
    sessions56d: number;
    minutes28d: number;
    minutes56d: number;
    load28d: number | null;
    distance28d: number | null;
  };
  durability: {
    longestRecentMinutes: number | null;
    p80SessionMinutes: number | null;
    p90SessionMinutes: number | null;
    safeSessionMinutes: number;
    safeLongSessionMinutes: number;
  };
  intensity: {
    lowMinutesShare: number | null;
    moderateMinutesShare: number | null;
    highMinutesShare: number | null;
    hardSessions7d: number;
    hardSessions28d: number;
  };
  anchors: SportAnchors;
  limiters: string[];
  contraindications: string[];
}
```

### 2.1 Confidence 判定

```ts
high:
  sessions56d >= 8
  and at least one reliable anchor exists
  and >= 70% sessions have HR/power/pace physiological signal

medium:
  sessions56d >= 3
  and at least duration + distance/pace is reliable

low:
  fewer samples, noisy samples, missing physiological signal, or contradictory data
```

取舍：

- 这个 confidence 是工程上的数据置信度，不是文献中的竞技水平等级。
- 目的：控制计划能开多细、多强、多冒险。

## 3. 最长可承受训练

问题：用户把可用时长拉高时，系统不能把单节阈值课或长跑无限拉长。

### 3.1 通用公式

```ts
safeLongSessionMinutes = min(
  p90SessionMinutes * sportMultiplier,
  longestRecentMinutes * maxIncreaseMultiplier,
  sportWeeklyBudgetMinutes * longSessionShareCap,
  absoluteCapByLevelAndSport
)
```

默认参数：

```ts
running:
  sportMultiplier = 1.10 to 1.15
  maxIncreaseMultiplier = 1.05 to 1.10
  longSessionShareCap:
    novice: 0.30
    developing: 0.35
    trained: 0.40
    advanced: 0.45

cycling:
  sportMultiplier = 1.15 to 1.25
  maxIncreaseMultiplier = 1.10 to 1.20
  longSessionShareCap:
    novice: 0.35
    developing: 0.45
    trained: 0.50
    advanced: 0.55

swimming:
  use distance/meters when pool data is reliable;
  otherwise cap by recent sustained swim duration.
```

取舍：

- 跑步冲击负荷高于骑行，所以跑步更保守。
- 不采用“每周只能加 10%”作为硬规则。跑步伤病风险是多因素的，10% rule 在研究中并不稳固。
- 初版用 P80/P90 + longest recent + weekly share，比直接用历史最长更抗异常值。

参考：

- Damsted et al. 2018 系统综述：训练负荷突然变化与跑步伤病风险的证据有限但有信号，尤其是距离/速度/频率的近期变化。
- Buist et al. 2008 RCT：基于 10% rule 的更渐进跑步计划并未降低新手跑者伤病数量；因此 10% 不能作为硬规则。
- 2024 umbrella review：跑步伤病风险是训练特征、健康生活方式、形态和生物力学因素共同作用，不能只看周量。
- Impellizzeri / ACWR critique: 不把单一增长率当因果阈值。

## 4. 强度分布

### 4.1 采用 3-zone 模型

```ts
low: below LT1 / VT1
moderate: LT1 to LT2
high: above LT2 / critical intensity
```

映射：

```ts
Garmin HR zones:
  Z1-Z2 => low
  Z3 => moderate
  Z4-Z5 => high

running pace:
  slower than easy / zone2 anchor => low
  tempo range => moderate
  threshold/VO2 intervals => high

cycling power:
  endurance => low
  tempo / sweet spot => moderate
  threshold / VO2 / anaerobic => high
```

### 4.2 计划约束

默认周分布：

```ts
novice:
  high sessions: 0-1
  high minutes share: 0-5%
  low minutes share: >= 80%

developing:
  high sessions: 1
  high minutes share: 5-8%
  low minutes share: >= 75%

trained:
  high sessions: 1-2
  high minutes share: 5-12%
  low minutes share: 70-85%

advanced:
  high sessions: 2, rarely 3 if readiness green
  high minutes share: 8-15%
  low minutes share: 70-85%
```

取舍：

- Seiler / Esteve-Lanao / Stöggl & Sperlich 支持耐力项目中大量低强度、少量高强度的组织方式。
- 不机械写死 80/20，因为不同项目、训练阶段、目标和训练年限会改变 pyramidal / polarized 的适配。
- Science of Running 提醒“中间强度”不是永远坏，但必须有明确训练目的。因此 moderate 不被禁止，只被控制剂量。

参考：

- Seiler & Kjerland 2006, intensity distribution in elite endurance athletes.
- Esteve-Lanao et al. 2007, intensity distribution and runner performance.
- Stöggl & Sperlich 2014, polarized training in endurance athletes.
- Triathlete 80/20 article as product-facing practical framing.
- Science of Running discussion on the in-between zone.

## 5. 能力锚点：跑步、骑行、游泳

### 5.1 Running anchors

优先级：

```ts
1. Garmin lactateThresholdPace / lactateThresholdHr if recent and consistent
2. Reliable threshold-labelled or tempo-labelled runs
3. Sustained 20-50 min efforts, filtered by HR/load quality
4. Critical speed field test if scheduled by platform
5. Conservative estimate from easy pace only, confidence low
```

Critical speed 公式：

```ts
criticalSpeed = (distance2 - distance1) / (time2 - time1)
```

可用测试组合：

- 3 min + 9/12 min all-out
- 1500 m + 3000 m
- 5 km + 10 km race efforts

实现边界：

- 单次最快配速不能直接当 threshold。
- 如果 threshold anchor 低置信度，禁止安排精准 threshold / VO2 课，只安排 RPE/HR-controlled aerobic 或安排测试周。

参考：

- Poole, Burnley, Vanhatalo, Rossiter, Jones 2016: CP/CS 是重要疲劳阈值框架，能区分可稳定与不可稳定的强度域。
- Burnley & Jones 2016: power-duration / speed-duration relationship 可用于理解可持续时间。
- TrainingPeaks threshold framework.

### 5.2 Cycling anchors

优先级：

```ts
1. Garmin/user FTP or power zones, if recent
2. Reliable threshold-labelled ride normalizedPower
3. 20 min best power * 0.95, confidence max medium
4. Critical power model from multiple max efforts, if enough data
5. HR-only endurance/tempo zones, no power prescription
```

取舍：

- FTP 20 min * 0.95 是常见实践，但不等价于实验室 MLSS / CP，对部分骑手会高估或低估。
- 因此它可以生成训练范围，但不能支撑高风险 over-under / VO2 处方，除非同时有高置信历史。
- 若 20min FTP 与 Garmin FTP / 历史 threshold rides 差异大于 8-10%，应降低 anchor confidence，安排测试而不是直接提高训练强度。

参考：

- TrainingPeaks / Coggan power training levels.
- Poole et al. 2016 critical power framework.
- Borszcz et al. / related FTP validity studies: FTP 与 lactate parameters / MLSS 相关但不可直接等同。
- Karsten et al. 2021: 20min FTP 与 CP 测试关系可用作参考，但 agreement 不是无条件等价。

### 5.3 Swimming anchors

CSS 公式：

```ts
CSS = (400m - 200m) / (time400 - time200)
```

优先级：

```ts
1. Recent 400m/200m CSS test, pool length known
2. Reliable threshold/tempo swim samples
3. Sustained pool swims >= 800m and >= 15min
4. No CSS: technique/aerobic only, no high-intensity CSS prescription
```

取舍：

- 游泳 GPS 和泳池长度错误会显著污染配速。
- 没有 poolLength / reliable pace 时，游泳能力置信度必须降级。

参考：

- Wakayoshi et al. 1992, simple method for determining critical speed as swimming fatigue threshold.
- Wakayoshi et al. 1992, validity of critical velocity as swimming performance index.
- Wakayoshi et al. 1993, 200/400m simplified method correlated with 4 mmol/L blood lactate velocity and 400m performance.

## 6. Recovery / Readiness

### 6.1 输入信号

```ts
sleepScore
sleepDurationHours
hrvStatus
trainingStatus
recoveryTimeHours
latestHardStimulusHoursAgo
subjective fatigue if user supplies it later
```

### 6.2 规则

```ts
red readiness:
  recent hard stimulus < 24h and recoveryTimeHours > 24
  or HRV poor/unbalanced + sleep poor + load elevated
  or high injury signal + elevated load

yellow readiness:
  one major recovery signal is poor
  or acute load is elevated
  or monotony high

green readiness:
  no major recovery signal and load stable
```

取舍：

- HRV-guided training 有研究支持，但需要个人基线和连续趋势；单日 HRV 不足以决定训练。
- Garmin 当前字段可能是状态标签而非原始 HRV，因此先用作风险信号。
- 睡眠也是风险信号，不单独决定红灯。

参考：

- Kiviniemi HRV-guided endurance training.
- Vesterinen individualized endurance training using recovery status.
- Bellenger HRV monitoring systematic review.
- Fullagar sleep and athletic performance review.

### 6.3 Garmin 官方数据融合层

Garmin 官方公开资料中，Health API 和 Activity API 的边界要明确区分：

- Health API: all-day health metrics，包括 steps、intensity minutes、sleep、calories、heart rate、stress、Pulse Ox、Body Battery、body composition、respiration、blood pressure、beat-to-beat interval 等。
- Activity API: 活动期间采集的 detailed fitness data，包括 running / cycling / swimming / strength 等活动细节，并可访问 FIT / GPX / TCX。
- Training API: 发布 workouts 和 training plans 到 Garmin Connect calendar，不负责健康/训练状态数据读取。

因此实现不能假设某个 Garmin 账号一定有 `trainingStatus`、`trainingReadiness`、`VO2max`、`recoveryTime`。这些数据取决于设备型号、用户是否授权、是否同步、是否佩戴睡觉、是否有足够历史、运动类型和传感器条件。

代码层需要为每个 Garmin 信号维护：

```ts
interface GarminSignal<T> {
  value: T | null;
  available: boolean;
  source: 'health_api' | 'activity_api' | 'fit_file' | 'garmin_connect_private' | 'derived' | 'user_input';
  freshnessDays: number | null;
  confidence: 'low' | 'medium' | 'high';
  missingReason?: string;
}
```

建议新增：

```ts
export interface GarminPhysiologySignals {
  sleepScore: GarminSignal<number>;
  sleepDurationHours: GarminSignal<number>;
  hrvStatus: GarminSignal<'balanced' | 'unbalanced' | 'low' | 'poor' | 'no_status' | string>;
  stressAvg: GarminSignal<number>;
  bodyBatteryMorning: GarminSignal<number>;
  bodyBatteryMin: GarminSignal<number>;
  vo2MaxRunning: GarminSignal<number>;
  vo2MaxCycling: GarminSignal<number>;
  trainingStatus: GarminSignal<string>;
  trainingReadiness: GarminSignal<number>;
  recoveryTimeHours: GarminSignal<number>;
  acuteLoad: GarminSignal<number>;
  chronicLoad: GarminSignal<number>;
  loadFocus: GarminSignal<{
    lowAerobic: number | null;
    highAerobic: number | null;
    anaerobic: number | null;
  }>;
}
```

### 6.4 Garmin 指标如何进入训练引擎

#### Sleep Score

Garmin 官方定义：

- 0-100 分。
- 90-100 excellent，80-89 good，60-79 fair，<60 poor。
- 由睡眠时长、睡眠质量、睡眠期间 stress、deep/light/REM、awake time、restlessness，以及 HRV 派生的自主神经恢复证据共同决定。

采用：

```ts
if sleepScore >= 80:
  sleepRisk = 'low'
else if sleepScore >= 60:
  sleepRisk = 'moderate'
else:
  sleepRisk = 'high'
```

缺失降级：

```ts
if sleepScore missing and sleepDurationHours exists:
  use duration-only fallback with low confidence
else:
  sleepRisk = 'unknown'
```

取舍：

- 睡眠分数不能单独禁止训练。
- 连续 2-3 晚 poor/fair 才显著影响本周计划。
- 单晚 poor 睡眠只降低当天高强度优先级。

#### HRV Status

Garmin 官方定义：

- 需要约 3 周连续睡眠数据建立个人 baseline。
- `balanced`: 7-day average HRV 在个人 baseline 内。
- `unbalanced`: 7-day average 高于或低于 baseline。
- `low`: 显著低于 baseline。
- `poor`: baseline 本身低于年龄相关健康标准。

采用：

```ts
balanced => recoveryRisk low
unbalanced => recoveryRisk moderate
low or poor => recoveryRisk high
no_status or missing => unknown, not green
```

取舍：

- 不比较不同用户的 HRV 原始值。
- 高 HRV 也可能 unbalanced，不能简单写成越高越好。
- HRV 作为趋势信号，不单独决定 red readiness；必须和 training load、sleep、stress 或主观疲劳共同触发。

#### Stress

Garmin 官方定义：

- stress level 0-100，主要基于 HR 和 HRV。
- 0-25 resting，26-50 low，51-75 medium，76-100 high。
- 高活动期间 stress 不记录，会标记为 unmeasurable。

采用：

```ts
if stressAvg <= 25:
  stressRisk = 'low'
else if stressAvg <= 50:
  stressRisk = 'moderate'
else:
  stressRisk = 'high'
```

取舍：

- 使用夜间 stress / 近 3 日 stress history 优先于全天平均，因为全天平均容易被非训练活动污染。
- stress 是生理压力，不等于心理压力。
- 缺失时不扣分；只降低 readiness confidence。

#### Body Battery

Garmin 官方说明 Body Battery 由 physical activity、stress、rest、sleep 的综合影响生成，用于表示可用能量。

采用：

```ts
morningBodyBattery >= 75 => low risk
51-74 => moderate-low risk
26-50 => moderate risk
0-25 => high risk
```

取舍：

- Body Battery 与 Training Readiness 不等价。Body Battery 更偏全天能量，Training Readiness 更偏“是否适合训练”。
- 没有 Body Battery 时不影响计划；有时可作为 sleep/stress 的补充。

#### VO2 Max

Garmin 官方定义：

- VO2max 是心肺适能和有氧表现能力指标。
- Garmin 通过跑步时外部负荷（配速）与内部负荷（身体努力程度）关系估算。
- Cycling VO2max / training status 通常需要骑行功率计等条件。
- Garmin 还会把 VO2max 用于 training effect、recovery time、optimal weekly training load 和 training status。

采用：

```ts
if vo2Max has >= 3 recent values and trend stable:
  use trend for fitness direction
else:
  use only as descriptive anchor
```

取舍：

- VO2max 不直接决定配速处方。
- VO2max 上升/下降趋势可辅助判断 trainingStatus，但不能替代 threshold pace / FTP / CSS。
- 如果 VO2max 与实际历史配速冲突，以最近可靠活动表现为主。

#### Training Load / Acute Load

Garmin 官方定义：

- Training load 是 EPOC-based metric，用来描述活动对身体的生理影响和恢复需求。
- Exercise load 表示单次活动 strenuousness。
- Acute load 是近期活动的加权移动平均：新活动完整加入，随后约 10 天逐渐衰减，并归一化到 7-day window。
- 旧设备可能只提供简单 7-day load。

采用：

```ts
if Garmin acuteLoad exists:
  use acuteLoad as primary recent load
else if per-activity trainingLoad exists:
  reconstruct 7d and 28d load from activities
else:
  fallback to duration * intensityWeight
```

取舍：

- Garmin load 比分钟数更接近生理压力，但仍是设备算法代理指标。
- 强度分布仍需用 workout type / HR zones / pace / power 重新估计，不能只靠 load 总数。
- 对 strength/swim/indoor 活动，Garmin load 可能低估；需允许用户主观反馈修正。

#### Load Focus

Garmin 官方将训练负荷分成 low aerobic、high aerobic、anaerobic 三类，并建议训练分布要覆盖三类。

采用映射：

```ts
lowAerobic => Training Engine low
highAerobic => Training Engine moderate/high aerobic
anaerobic => Training Engine high-neuromuscular/anaerobic
```

取舍：

- Load Focus 可作为强度分布校验的辅助证据。
- 若 Garmin load focus 与我们基于模板/HR/pace/power 的分布冲突，保留冲突标记，不直接覆盖。

#### Training Status

Garmin 官方定义：

- Training Status 是长期训练习惯视角。
- 主要考虑 VO2max 变化、acute 7-day training load、load change；支持 HRV 的设备还会加入 HRV status。
- 状态包括 peaking、productive、maintaining、recovery、unproductive、detraining、overreaching、strained、no status。

采用：

```ts
productive | peaking:
  no penalty
maintaining:
  allow normal training, avoid unnecessary intensity increase
recovery:
  keep lower volume or transition back gradually
unproductive:
  reduce intensity if load is high or recovery signals poor
detraining:
  rebuild gradually; do not jump to user requested high volume
overreaching | strained:
  force yellow/red readiness; no VO2/threshold/double days
no_status:
  ignore as unavailable
```

取舍：

- Training Status 是 Garmin 的综合判断，不透明，不能作为唯一决策。
- 它适合做 override guardrail：当 Garmin 已经判定 strained/overreaching 时，我们应保守。

#### Recovery Time

Garmin 官方定义：

- Recovery Time 是倒计时，表示预计何时充分恢复并适合再次进行 substantial challenge。
- 它不是要求完全休息；remaining recovery 很高时，easy ride/run 仍可能可以甚至有益。
- 计算考虑活动 duration/intensity、当前 fitness、活动历史、开始新活动时剩余 recovery time；部分设备还考虑 all-day stress、sleep 和 day-to-day activity。

采用：

```ts
if recoveryTimeHours >= 36:
  no high intensity today
else if recoveryTimeHours >= 18:
  high intensity only if readiness otherwise green and recent hard cooldown passed
else:
  no recovery-time restriction
```

取舍：

- Recovery Time 限制的是 hard workout，不限制 easy aerobic/recovery。
- 若 Recovery Time 缺失，回退到 latestHardStimulusHoursAgo + activity load。

#### Training Readiness

Garmin 官方定义：

- Training Readiness 是 1-100 分，用于判断今天是否适合训练。
- 组件包括 last night sleep score、recovery time、HRV status、acute load、last 3 nights sleep history、last 3 days stress history。
- Garmin 级别：95-100 prime，75-94 high，50-74 moderate，25-49 low，1-24 poor。

采用：

```ts
score >= 75:
  readinessSignal = green
50-74:
  readinessSignal = yellow-green; allow normal, avoid stacking hard sessions
25-49:
  readinessSignal = yellow; no VO2, threshold only if already planned and other signals green
1-24:
  readinessSignal = red; recovery/easy only
```

取舍：

- 如果 Training Readiness 可用，优先作为当天训练强度信号。
- 如果不可用，用它的组件重建 readiness。
- 如果用户主观反馈与 Garmin 冲突，要求降级而不是升级：用户说很累时保守；用户说很精神但 Garmin red 时只允许低强度或提示风险。

### 6.5 缺失数据策略

每个信号要区分三种状态：

```ts
missing: 用户没有这个数据
stale: 数据太旧
low_confidence: 数据存在但不满足条件
```

降级顺序：

```ts
Training Readiness missing
  => use sleep + HRV + recovery time + acute load + stress

HRV missing
  => use sleepScore + resting HR trend if available + subjective fatigue

Sleep Score missing
  => use sleepDurationHours only, confidence low

Training Load missing
  => reconstruct from per-activity trainingLoad
  => fallback to duration * intensityWeight

VO2max missing
  => use threshold pace / FTP / CSS anchors
  => if anchors missing, prescribe by HR/RPE and schedule test

Recovery Time missing
  => use latest hard stimulus cooldown + load trend

Training Status missing
  => ignore; do not infer status label
```

计划生成时必须输出 `readinessConfidence`：

```ts
high:
  >= 4 independent recent signals, including load and at least one recovery signal
medium:
  load plus one recovery signal, or Garmin Training Readiness
low:
  activity history only, or user input only
```

如果 `readinessConfidence = low`：

- 禁止自动生成 aggressive plan。
- 高强度最多 1 次。
- 不安排双阈值。
- 不安排新的测试课，除非测试课本身是为了建立能力画像，且强度可控。

## 7. Periodization / Taper / Recovery Week

### 7.1 阶段划分

```ts
if no raceDate:
  phase = base or general_preparation

if raceDate exists:
  weeksToRace > 12 => base
  6-12 => build
  2-6 => peak / race_specific
  0-2 => taper
  after race or readiness red => recovery
```

### 7.2 阶段策略

```ts
base:
  build aerobic volume, technique, strength

build:
  add race-specific workouts, controlled threshold/tempo

peak:
  specific intensity, brick for triathlon, reduce junk volume

taper:
  reduce volume, maintain some intensity, avoid new stimulus

recovery:
  reduce volume and high intensity; restore readiness
```

Taper 初版：

```ts
8-14 days for most endurance race targets
volume reduction target: about 40-60%
maintain frequency moderately
keep short intensity touches if readiness allows
```

取舍：

- Mujika & Padilla / Bosquet meta-analysis 支持减量而非完全休息，保留强度。
- taper 需要目标项目和比赛距离调整，初版先用保守默认。

参考：

- Mujika & Padilla 2003.
- Bosquet et al. 2007 taper meta-analysis.
- TrainingPeaks periodization framework as product-facing explanation.

## 8. Strength Training

### 8.1 模板类型

```ts
general_strength
runner_strength
cycling_core_strength
swim_shoulder_stability
maintenance_strength
mobility_prehab
```

### 8.2 安排规则

```ts
base:
  1-2 strength sessions / week

build:
  1 session / week, avoid compromising key workouts

peak/taper:
  maintenance only, low soreness risk

do not schedule heavy lower-body strength:
  within 24h before key run/brick/VO2
```

取舍：

- 力量训练能改善跑步经济性和耐力表现，但会带来局部疲劳。
- 因此 strength 要计入训练负荷，不再作为“休息日装饰”。

参考：

- Rønnestad & Mujika 2014.
- Berryman et al. 2018 meta-analysis.

## 9. Brick Workouts

适用：

```ts
enabledSports includes cycling and running
goal indicates triathlon / duathlon / bike-run race specificity
phase is build or peak
readiness is green or stable yellow
```

规则：

```ts
novice:
  0-1 short brick every 1-2 weeks
  bike easy/moderate + 5-15 min easy run

trained:
  up to 1 brick / week in build/peak
  run duration 15-40 min depending on capacity

advanced:
  race-specific brick possible, but not adjacent to hard run
```

取舍：

- brick 是专项适应，不是单纯加量。
- 如果用户没有铁三/换项目标，不默认安排。

参考：

- Millet & Vleck 2000 review: cycle-run transition changes physiological/biomechanical demands and increases running energy cost compared with isolated running.
- Systematic review on running after cycling: evidence is mixed by outcome, but transition-specific physiological/biomechanical constraints justify targeted practice.
- Triathlete brick training article as practical product reference.

## 10. Fueling / Hydration

规则：

```ts
duration < 75min:
  no mandatory fueling instruction

75-150min:
  suggest 30-60g carbohydrate / hour if moderate or long endurance

150min+:
  suggest 60-90g carbohydrate / hour, multiple transportable carbs if tolerated

all long sessions:
  hydration reminder and gut-training note
```

取舍：

- 这是训练执行安全提示，不是个性化营养医疗建议。
- 初版不根据体重和汗率精细化，因为缺少数据。

参考：

- Thomas, Erdman, Burke 2016 Nutrition and Athletic Performance position stand.
- Jeukendrup 2014: endurance exercise carbohydrate advice can be duration-specific; ultra-endurance recommendations may approach 90 g/h when multiple transportable carbohydrates are tolerated.
- Multiple transportable carbohydrate literature: high intake above about 50-60 g/h should use multiple transportable carbohydrates to improve oxidation and reduce gut accumulation risk.

## 11. Plan Validator 新增规则

`validation.ts` 应增加：

```ts
weekly_volume_within_capacity
single_session_duration_within_capacity
long_session_share_within_capacity
intensity_distribution_within_phase
hard_sessions_within_capacity
readiness_allows_intensity
anchor_confidence_allows_precision
recovery_week_required_if_risk_red
taper_shape_valid_if_near_race
brick_requires_triathlon_context
strength_fatigue_spacing
fueling_note_required_for_long_session
```

示例：

```ts
if workout.type === 'threshold' and sport.anchor.threshold.confidence === 'low':
  violation: anchor_confidence_allows_precision

if run.long.duration > capacity.running.durability.safeLongSessionMinutes:
  violation: single_session_duration_within_capacity

if week.highMinutesShare > capacity.guardrails.maxHighMinutesShare:
  violation: intensity_distribution_within_phase
```

## 12. 前端需要新增/调整的输入

现有 `dailyPreferredMinutes` 应降级为“单日上限”，不能再作为每节课目标。

新增：

```ts
weeklyAvailableMinutes
dayAvailability: Array<{ dayOfWeek, maxMinutes, windows }>
trainingAgeMonths
recentLongestRunMinutes
recentLongestRideMinutes
recentLongestSwimMeters
triathlonGoal?: boolean
acceptDoubleDays?: boolean
strengthPreference?: 'none' | 'maintenance' | 'build'
subjectiveFatigue?: 'fresh' | 'normal' | 'tired'
```

如果 Garmin 数据足够，前端少问；数据不足时才补问。

## 13. 实施顺序

P0:

1. `training-capacity.ts`
2. `training-budget.ts`
3. 扩展 `validation.ts`
4. 移除 `dailyPreferredMinutes` 对单节课的直接覆盖

P1:

1. `periodization.ts`
2. `session-allocator.ts`
3. anchor confidence and test-session scheduling
4. readiness integration

P2:

1. strength templates
2. brick templates
3. fueling notes
4. front-end capacity explanation

## 14. 主要参考资料

- Foster C. 1998. Monitoring training in athletes with reference to overtraining syndrome.
  https://pubmed.ncbi.nlm.nih.gov/9662690/
- Gabbett TJ. 2016. The training-injury prevention paradox.
  https://pubmed.ncbi.nlm.nih.gov/26758673/
- Impellizzeri FM et al. 2020. ACWR methodological concerns.
  https://pubmed.ncbi.nlm.nih.gov/32339342/
- Damsted C et al. 2018. Association between changes in training load and running-related injuries: systematic review.
  https://pubmed.ncbi.nlm.nih.gov/30534459/
- Buist I et al. 2008. No effect of a graded training program on running-related injuries in novice runners.
  https://doi.org/10.1177/0363546507307505
- Risk factors for running-related injuries: umbrella systematic review.
  https://pubmed.ncbi.nlm.nih.gov/38697289/
- Seiler S, Kjerland GO. 2006. Quantifying training intensity distribution in elite endurance athletes.
  https://pubmed.ncbi.nlm.nih.gov/16430681/
- Esteve-Lanao J et al. 2007. Impact of training intensity distribution on performance in endurance athletes.
  https://pubmed.ncbi.nlm.nih.gov/17414804/
- Stöggl T, Sperlich B. 2014. Polarized training has greater impact on key endurance variables.
  https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2014.00033/full
- Mujika I, Padilla S. 2003. Scientific bases for precompetition tapering strategies.
  https://pubmed.ncbi.nlm.nih.gov/12840640/
- Bosquet L et al. 2007. Effects of tapering on performance: a meta-analysis.
  https://pubmed.ncbi.nlm.nih.gov/17762369/
- Kiviniemi AM et al. HRV-guided endurance training.
  https://pubmed.ncbi.nlm.nih.gov/17383921/
- Bellenger CR et al. 2016. HRV monitoring in athletes: systematic review/meta-analysis.
  https://pubmed.ncbi.nlm.nih.gov/27075623/
- Fullagar HHK et al. 2015. Sleep and athletic performance.
  https://pubmed.ncbi.nlm.nih.gov/25315456/
- Rønnestad BR, Mujika I. 2014. Optimizing strength training for running and cycling endurance performance.
  https://pubmed.ncbi.nlm.nih.gov/23914932/
- Berryman N et al. 2018. Strength training for middle- and long-distance performance.
  https://pubmed.ncbi.nlm.nih.gov/28459360/
- Thomas DT, Erdman KA, Burke LM. 2016. Nutrition and Athletic Performance.
  https://pubmed.ncbi.nlm.nih.gov/26920240/
- Jeukendrup AE. 2014. A step towards personalized sports nutrition: carbohydrate intake during exercise.
  https://pubmed.ncbi.nlm.nih.gov/24791914/
- Multiple Transportable Carbohydrates During Exercise: Current Limitations and Directions for Future Research.
  https://pubmed.ncbi.nlm.nih.gov/25559901/
- Jeukendrup AE. The new carbohydrate intake recommendations.
  https://pubmed.ncbi.nlm.nih.gov/23765351/
- Poole DC et al. 2016. Critical Power: An Important Fatigue Threshold in Exercise Physiology.
  https://pubmed.ncbi.nlm.nih.gov/27031742/
- Burnley M, Jones AM. 2016. Power-duration relationship: physiology, fatigue, and limits of human performance.
  https://pubmed.ncbi.nlm.nih.gov/27806677/
- Wakayoshi K et al. 1992. A simple method for determining critical speed as swimming fatigue threshold.
  https://pubmed.ncbi.nlm.nih.gov/1521952/
- Wakayoshi K et al. 1992. Determination and validity of critical velocity as an index of swimming performance.
  https://pubmed.ncbi.nlm.nih.gov/1555562/
- Functional Threshold Power Is Not Equivalent to Lactate Parameters in Trained Cyclists.
  https://pubmed.ncbi.nlm.nih.gov/31269000/
- Functional threshold power is not a valid marker of the maximal metabolic steady state.
  https://pubmed.ncbi.nlm.nih.gov/36803419/
- Relationship Between the Critical Power Test and a 20-min Functional Threshold Power Test in Cycling.
  https://pubmed.ncbi.nlm.nih.gov/33551839/
- Millet GP, Vleck VE. 2000. Physiological and biomechanical adaptations to the cycle to run transition in Olympic triathlon.
  https://pubmed.ncbi.nlm.nih.gov/11049151/
- Biomechanical and physiological implications to running after cycling: systematic review.
  https://pubmed.ncbi.nlm.nih.gov/35871903/
- TrainingPeaks: What Is Training Periodization?
  https://www.trainingpeaks.com/blog/what-is-training-periodization/
- TrainingPeaks: Power Training Levels.
  https://www.trainingpeaks.com/blog/power-training-levels/
- Triathlete: 80/20 Triathlon Training.
  https://www.triathlete.com/training/80-20-triathlon-training-the-what-why-and-how/
- Science of Running.
  https://www.scienceofrunning.com/
- Endurance Science Labs.
  https://endurancesciencelabs.com/
- Garmin Health API.
  https://developer.garmin.com/gc-developer-program/health-api/
- Garmin Activity API.
  https://developer.garmin.com/gc-developer-program/activity-api/
- Garmin Training API.
  https://developer.garmin.com/gc-developer-program/training-api/
- Garmin Sleep Score and insights.
  https://www.garmin.com/en-US/garmin-technology/health-science/sleep-score/
- Garmin HRV Status.
  https://www.garmin.com/en-US/garmin-technology/health-science/hrv-status/
- Garmin Stress Tracking.
  https://www.garmin.com/en-US/garmin-technology/health-science/stress-tracking/
- Garmin Body Battery.
  https://www.garmin.com/en-US/garmin-technology/health-science/body-battery/
- Garmin VO2 Max.
  https://www.garmin.com/en-US/garmin-technology/running-science/physiological-measurements/vo2-max/
- Garmin Training Load.
  https://www.garmin.com/en-US/garmin-technology/running-science/physiological-measurements/training-load/
- Garmin Training Status.
  https://www.garmin.com/en-US/garmin-technology/running-science/physiological-measurements/training-status/
- Garmin Recovery Time.
  https://www.garmin.com/en-US/garmin-technology/running-science/physiological-measurements/recovery-time/
- Garmin Training Readiness.
  https://www.garmin.com/en-US/garmin-technology/running-science/physiological-measurements/training-readiness/
