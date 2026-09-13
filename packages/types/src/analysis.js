import { z } from "zod";

export const ANALYSIS_CONTRACT_VERSION = 1;
export const ANALYSIS_WORKSPACES = Object.freeze([
  "budgeting",
  "portfolio",
  "research",
  "cross-workspace",
]);
export const ANALYSIS_VALUE_TYPES = Object.freeze([
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "currency",
]);

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const decimalSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/)
  .refine((value) => value !== "-0", "Decimal must not be negative zero");
const dateSchema = z.iso.date();
const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Datetime must use UTC Z notation");
const timezoneSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Timezone must be an IANA timezone");
const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const valueTypeSchema = z.enum(ANALYSIS_VALUE_TYPES);

const unitSchema = z
  .object({
    kind: z.enum(["money", "percentage", "quantity", "count", "duration"]),
    currency: currencySchema.optional(),
    currencyParameterId: identifierSchema.optional(),
    percentageBasis: z.enum(["ratio", "percent"]).optional(),
    scale: z.number().int().min(0).max(12).optional(),
  })
  .strict()
  .superRefine((unit, context) => {
    if (unit.kind === "money") {
      if (
        (unit.currency === undefined) ===
        (unit.currencyParameterId === undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["currency"],
          message:
            "Money units require exactly one literal or parameter currency",
        });
      }
    } else if (
      unit.currency !== undefined ||
      unit.currencyParameterId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Only money units may declare currency",
      });
    }
    if ((unit.kind === "percentage") !== (unit.percentageBasis !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["percentageBasis"],
        message: "Percentage units require a basis and other units forbid it",
      });
    }
  });

function valueMatchesType(value, declaration, nullable = false) {
  if (value === null) return nullable;
  let valid;
  switch (declaration.type) {
    case "integer":
      valid = Number.isInteger(value);
      break;
    case "decimal":
      valid =
        typeof value === "string" && decimalSchema.safeParse(value).success;
      break;
    case "boolean":
      valid = typeof value === "boolean";
      break;
    case "date":
      valid = typeof value === "string" && dateSchema.safeParse(value).success;
      break;
    case "datetime":
      valid =
        typeof value === "string" && dateTimeSchema.safeParse(value).success;
      break;
    case "currency":
      valid =
        typeof value === "string" && currencySchema.safeParse(value).success;
      break;
    default:
      valid = typeof value === "string";
  }
  if (!valid) return false;
  if (declaration.type === "decimal" && declaration.unit?.scale !== undefined) {
    return (value.split(".")[1] ?? "").length <= declaration.unit.scale;
  }
  return true;
}

function typedValueSchema(shape) {
  return z
    .object(shape)
    .strict()
    .superRefine((value, context) => {
      if (
        value.defaultValue !== undefined &&
        !valueMatchesType(value.defaultValue, value)
      ) {
        context.addIssue({
          code: "custom",
          path: ["defaultValue"],
          message: `Default value does not match ${value.type}`,
        });
      }
      if (value.unit !== undefined && value.type !== "decimal") {
        context.addIssue({
          code: "custom",
          path: ["unit"],
          message: "Only decimal values may declare a unit",
        });
      }
    });
}

const datasetSchema = z
  .object({
    id: identifierSchema,
    schemaVersion: z.number().int().positive(),
    requiredColumns: z.array(identifierSchema).max(256).default([]),
    authorizationScope: z.string().min(1).max(128),
  })
  .strict();
const parameterSchema = typedValueSchema({
  id: identifierSchema,
  label: z.string().min(1).max(160),
  type: valueTypeSchema,
  required: z.boolean(),
  defaultValue: scalarSchema.optional(),
  sensitive: z.boolean().default(false),
  unit: unitSchema.optional(),
});
const assumptionSchema = typedValueSchema({
  id: identifierSchema,
  label: z.string().min(1).max(160),
  type: valueTypeSchema,
  defaultValue: scalarSchema,
  editable: z.boolean(),
  source: z.enum(["user", "template"]),
  unit: unitSchema.optional(),
});
const calculationSchema = z
  .object({
    id: identifierSchema,
    label: z.string().min(1).max(160),
    kind: z.enum(["metric", "formula"]),
    expression: z.string().min(1).max(8_192),
    resultType: valueTypeSchema,
    languageVersion: z.string().min(1).max(64),
    metricVersion: z.string().min(1).max(64).optional(),
    dependencies: z.array(identifierSchema).max(128).default([]),
    unit: unitSchema.optional(),
    rounding: z
      .object({
        mode: z.literal("half-even"),
        scale: z.number().int().min(0).max(12),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((calculation, context) => {
    if (
      calculation.kind === "metric" &&
      calculation.metricVersion === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["metricVersion"],
        message: "Metric calculations require a version",
      });
    }
    if (
      calculation.unit !== undefined &&
      calculation.resultType !== "decimal"
    ) {
      context.addIssue({
        code: "custom",
        path: ["unit"],
        message: "Only decimal calculations may declare a unit",
      });
    }
  });
const columnSchema = z
  .object({
    id: identifierSchema,
    label: z.string().min(1).max(160),
    type: valueTypeSchema,
    nullable: z.boolean(),
    semanticType: z.string().min(1).max(128).optional(),
    unit: unitSchema.optional(),
    calculationId: identifierSchema.optional(),
    calculationVersion: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((column, context) => {
    if (column.unit !== undefined && column.type !== "decimal") {
      context.addIssue({
        code: "custom",
        path: ["unit"],
        message: "Only decimal columns may declare a unit",
      });
    }
    if (
      (column.calculationId === undefined) !==
      (column.calculationVersion === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["calculationVersion"],
        message: "Calculation id and version must be declared together",
      });
    }
  });

const fieldRefSchema = z
  .object({
    kind: z.literal("field"),
    datasetId: identifierSchema,
    columnId: identifierSchema,
  })
  .strict();
const metricRefSchema = z
  .object({ kind: z.literal("metric"), calculationId: identifierSchema })
  .strict();
const selectSchema = z
  .object({
    id: identifierSchema,
    source: z.discriminatedUnion("kind", [fieldRefSchema, metricRefSchema]),
  })
  .strict();
const filterRightSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("parameter"), id: identifierSchema }).strict(),
  z.object({ kind: z.literal("assumption"), id: identifierSchema }).strict(),
  z.object({ kind: z.literal("literal"), value: scalarSchema }).strict(),
]);
const filterSchema = z
  .object({
    left: fieldRefSchema,
    operator: z.enum([
      "eq",
      "neq",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "starts-with",
      "is-null",
      "is-not-null",
    ]),
    right: filterRightSchema.optional(),
  })
  .strict()
  .superRefine((filter, context) => {
    const unary = ["is-null", "is-not-null"].includes(filter.operator);
    if (unary === (filter.right !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["right"],
        message: unary
          ? "Unary filter forbids a right operand"
          : "Binary filter requires a right operand",
      });
    }
  });
const visualPlanSchema = z
  .object({
    kind: z.literal("visual-plan"),
    planVersion: z.number().int().positive(),
    datasetId: identifierSchema,
    select: z.array(selectSchema).min(1).max(256),
    joins: z
      .array(
        z
          .object({
            datasetId: identifierSchema,
            type: z.enum(["inner", "left"]),
            pathId: identifierSchema,
          })
          .strict(),
      )
      .max(32)
      .default([]),
    filters: z.array(filterSchema).max(128).default([]),
    groupBy: z.array(identifierSchema).max(128).default([]),
    orderBy: z
      .array(
        z
          .object({
            outputId: identifierSchema,
            direction: z.enum(["asc", "desc"]),
          })
          .strict(),
      )
      .max(128)
      .default([]),
    limit: z.number().int().positive().max(100_000).optional(),
    generatedSql: z.string().min(1).max(1_000_000).optional(),
  })
  .strict();
const customSqlSchema = z
  .object({
    kind: z.literal("custom-sql"),
    dialect: z.literal("postgresql"),
    text: z.string().min(1).max(1_000_000),
    datasetIds: z.array(identifierSchema).min(1).max(64),
    parameterBindings: z
      .array(
        z
          .object({
            parameterId: identifierSchema,
            startCodeUnit: z.number().int().nonnegative(),
            endCodeUnit: z.number().int().positive(),
          })
          .strict(),
      )
      .max(256)
      .default([]),
    visualConversion: z
      .object({
        status: z.enum(["convertible", "unsupported"]),
        reasonCode: identifierSchema.optional(),
      })
      .strict(),
    visualOrigin: visualPlanSchema.optional(),
  })
  .strict();

const requirementsSchema = z
  .object({
    columns: z.array(columnSchema).min(1).max(256),
    completeResult: z.boolean(),
  })
  .strict();
const presentationBase = { id: identifierSchema, requires: requirementsSchema };
const presentationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...presentationBase,
      kind: z.literal("grid"),
      bindings: z
        .object({ columns: z.array(identifierSchema).min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...presentationBase,
      kind: z.literal("line"),
      bindings: z
        .object({ x: identifierSchema, y: z.array(identifierSchema).min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...presentationBase,
      kind: z.literal("bar"),
      bindings: z
        .object({ x: identifierSchema, y: z.array(identifierSchema).min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...presentationBase,
      kind: z.literal("area"),
      bindings: z
        .object({ x: identifierSchema, y: z.array(identifierSchema).min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...presentationBase,
      kind: z.literal("pie"),
      bindings: z
        .object({ category: identifierSchema, value: identifierSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...presentationBase,
      kind: z.literal("pivot"),
      bindings: z
        .object({
          rows: z.array(identifierSchema),
          columns: z.array(identifierSchema),
          values: z.array(identifierSchema).min(1),
        })
        .strict(),
    })
    .strict(),
]);

function addDuplicateIssues(items, context, path) {
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id))
      context.addIssue({
        code: "custom",
        path: [path, index, "id"],
        message: `Duplicate id: ${item.id}`,
      });
    seen.add(item.id);
  }
  return seen;
}
function presentationBindings(presentation) {
  if (presentation.kind === "grid") return presentation.bindings.columns;
  if (["line", "bar", "area"].includes(presentation.kind))
    return [presentation.bindings.x, ...presentation.bindings.y];
  if (presentation.kind === "pie")
    return [presentation.bindings.category, presentation.bindings.value];
  return [
    ...presentation.bindings.rows,
    ...presentation.bindings.columns,
    ...presentation.bindings.values,
  ];
}
function sameUnit(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
function sameColumn(left, right) {
  return (
    left.type === right.type &&
    left.nullable === right.nullable &&
    sameUnit(left.unit, right.unit) &&
    left.calculationId === right.calculationId &&
    left.calculationVersion === right.calculationVersion
  );
}

function validateVisualPlanReferences(
  plan,
  context,
  path,
  {
    datasetIds,
    parameterIds,
    assumptionIds,
    calculationIds,
    calculations,
    columnIds,
    expectedColumns,
  },
) {
  const referencedDatasets = [
    plan.datasetId,
    ...plan.joins.map((join) => join.datasetId),
    ...plan.select.flatMap((entry) =>
      entry.source.kind === "field" ? [entry.source.datasetId] : [],
    ),
    ...plan.filters.map((filter) => filter.left.datasetId),
  ];
  for (const id of referencedDatasets) {
    if (!datasetIds.has(id))
      context.addIssue({
        code: "custom",
        path: [path],
        message: `Unknown dataset: ${id}`,
      });
  }
  const outputs = addDuplicateIssues(plan.select, context, `${path}.select`);
  for (const [index, entry] of plan.select.entries()) {
    if (!columnIds.has(entry.id))
      context.addIssue({
        code: "custom",
        path: [path, "select", index, "id"],
        message: `Selected output is not declared: ${entry.id}`,
      });
    if (
      entry.source.kind === "metric" &&
      (calculations.get(entry.source.calculationId)?.kind !== "metric" ||
        !calculationIds.has(entry.source.calculationId))
    )
      context.addIssue({
        code: "custom",
        path: [path, "select", index, "source"],
        message: `Unknown metric: ${entry.source.calculationId}`,
      });
  }
  for (const column of expectedColumns) {
    if (column.calculationId === undefined && !outputs.has(column.id))
      context.addIssue({
        code: "custom",
        path: [path, "select"],
        message: `Raw result column is not selected: ${column.id}`,
      });
  }
  for (const id of [
    ...plan.groupBy,
    ...plan.orderBy.map((value) => value.outputId),
  ]) {
    if (!outputs.has(id))
      context.addIssue({
        code: "custom",
        path: [path],
        message: `Unknown selected output: ${id}`,
      });
  }
  for (const [index, filter] of plan.filters.entries()) {
    if (
      filter.right?.kind === "parameter" &&
      !parameterIds.has(filter.right.id)
    )
      context.addIssue({
        code: "custom",
        path: [path, "filters", index, "right"],
        message: `Unknown parameter: ${filter.right.id}`,
      });
    if (
      filter.right?.kind === "assumption" &&
      !assumptionIds.has(filter.right.id)
    )
      context.addIssue({
        code: "custom",
        path: [path, "filters", index, "right"],
        message: `Unknown assumption: ${filter.right.id}`,
      });
  }
  return outputs;
}

const definitionBaseSchema = z
  .object({
    contractVersion: z.literal(ANALYSIS_CONTRACT_VERSION),
    definitionId: identifierSchema,
    definitionVersion: z.number().int().positive(),
    name: z.string().min(1).max(200),
    workspace: z.enum(ANALYSIS_WORKSPACES),
    datasets: z.array(datasetSchema).min(1).max(64),
    source: z.discriminatedUnion("kind", [visualPlanSchema, customSqlSchema]),
    parameters: z.array(parameterSchema).max(128).default([]),
    calculations: z.array(calculationSchema).max(256).default([]),
    assumptions: z.array(assumptionSchema).max(128).default([]),
    presentations: z.array(presentationSchema).max(64).default([]),
    expectedResult: z
      .object({ columns: z.array(columnSchema).min(1).max(256) })
      .strict(),
    reporting: z
      .object({
        currencyParameterId: identifierSchema,
        timezoneParameterId: identifierSchema,
        dateFromParameterId: identifierSchema,
        dateToParameterId: identifierSchema,
      })
      .strict(),
  })
  .strict();

export const analysisDefinitionSchema = definitionBaseSchema.superRefine(
  (definition, context) => {
    const datasetIds = addDuplicateIssues(
      definition.datasets,
      context,
      "datasets",
    );
    const parameterIds = addDuplicateIssues(
      definition.parameters,
      context,
      "parameters",
    );
    const calculationIds = addDuplicateIssues(
      definition.calculations,
      context,
      "calculations",
    );
    const assumptionIds = addDuplicateIssues(
      definition.assumptions,
      context,
      "assumptions",
    );
    addDuplicateIssues(definition.presentations, context, "presentations");
    const columnIds = addDuplicateIssues(
      definition.expectedResult.columns,
      context,
      "expectedResult.columns",
    );
    const parameters = new Map(
      definition.parameters.map((value) => [value.id, value]),
    );
    const calculations = new Map(
      definition.calculations.map((value) => [value.id, value]),
    );
    const columns = new Map(
      definition.expectedResult.columns.map((value) => [value.id, value]),
    );

    const referencedDatasets =
      definition.source.kind === "visual-plan"
        ? [
            definition.source.datasetId,
            ...definition.source.joins.map((join) => join.datasetId),
            ...definition.source.select.flatMap((entry) =>
              entry.source.kind === "field" ? [entry.source.datasetId] : [],
            ),
            ...definition.source.filters.map((filter) => filter.left.datasetId),
          ]
        : definition.source.datasetIds;
    for (const id of referencedDatasets) {
      if (!datasetIds.has(id))
        context.addIssue({
          code: "custom",
          path: ["source"],
          message: `Unknown dataset: ${id}`,
        });
    }

    if (definition.source.kind === "visual-plan") {
      const outputs = addDuplicateIssues(
        definition.source.select,
        context,
        "source.select",
      );
      for (const [index, entry] of definition.source.select.entries()) {
        if (!columnIds.has(entry.id))
          context.addIssue({
            code: "custom",
            path: ["source", "select", index, "id"],
            message: `Selected output is not declared: ${entry.id}`,
          });
        if (
          entry.source.kind === "metric" &&
          calculations.get(entry.source.calculationId)?.kind !== "metric"
        ) {
          context.addIssue({
            code: "custom",
            path: ["source", "select", index, "source"],
            message: `Unknown metric: ${entry.source.calculationId}`,
          });
        }
      }
      for (const column of definition.expectedResult.columns) {
        if (column.calculationId === undefined && !outputs.has(column.id))
          context.addIssue({
            code: "custom",
            path: ["source", "select"],
            message: `Raw result column is not selected: ${column.id}`,
          });
      }
      for (const id of [
        ...definition.source.groupBy,
        ...definition.source.orderBy.map((value) => value.outputId),
      ]) {
        if (!outputs.has(id))
          context.addIssue({
            code: "custom",
            path: ["source"],
            message: `Unknown selected output: ${id}`,
          });
      }
      for (const [index, filter] of definition.source.filters.entries()) {
        if (
          filter.right?.kind === "parameter" &&
          !parameterIds.has(filter.right.id)
        )
          context.addIssue({
            code: "custom",
            path: ["source", "filters", index, "right"],
            message: `Unknown parameter: ${filter.right.id}`,
          });
        if (
          filter.right?.kind === "assumption" &&
          !assumptionIds.has(filter.right.id)
        )
          context.addIssue({
            code: "custom",
            path: ["source", "filters", index, "right"],
            message: `Unknown assumption: ${filter.right.id}`,
          });
      }
    } else {
      addDuplicateIssues(
        definition.source.datasetIds.map((id) => ({ id })),
        context,
        "source.datasetIds",
      );
      const occupiedOffsets = new Set();
      for (const [
        index,
        binding,
      ] of definition.source.parameterBindings.entries()) {
        if (!parameterIds.has(binding.parameterId))
          context.addIssue({
            code: "custom",
            path: ["source", "parameterBindings", index, "parameterId"],
            message: `Unknown parameter: ${binding.parameterId}`,
          });
        if (
          binding.endCodeUnit <= binding.startCodeUnit ||
          definition.source.text.slice(
            binding.startCodeUnit,
            binding.endCodeUnit,
          ) !== `:${binding.parameterId}`
        )
          context.addIssue({
            code: "custom",
            path: ["source", "parameterBindings", index],
            message: "SQL parameter binding does not match its code-unit range",
          });
        for (
          let offset = binding.startCodeUnit;
          offset < binding.endCodeUnit;
          offset += 1
        ) {
          if (occupiedOffsets.has(offset))
            context.addIssue({
              code: "custom",
              path: ["source", "parameterBindings", index],
              message: "SQL parameter bindings overlap",
            });
          occupiedOffsets.add(offset);
        }
      }
      if (definition.source.visualOrigin !== undefined)
        validateVisualPlanReferences(
          definition.source.visualOrigin,
          context,
          "source.visualOrigin",
          {
            datasetIds,
            parameterIds,
            assumptionIds,
            calculationIds,
            calculations,
            columnIds,
            expectedColumns: definition.expectedResult.columns,
          },
        );
    }

    const dependencyIds = new Set([
      ...parameterIds,
      ...calculationIds,
      ...assumptionIds,
      ...columnIds,
    ]);
    for (const [index, calculation] of definition.calculations.entries()) {
      for (const id of calculation.dependencies) {
        if (!dependencyIds.has(id))
          context.addIssue({
            code: "custom",
            path: ["calculations", index, "dependencies"],
            message: `Unknown calculation dependency: ${id}`,
          });
      }
      if (
        calculation.unit?.currencyParameterId !== undefined &&
        (parameters.get(calculation.unit.currencyParameterId)?.type !==
          "currency" ||
          parameters.get(calculation.unit.currencyParameterId)?.required !==
            true)
      ) {
        context.addIssue({
          code: "custom",
          path: ["calculations", index, "unit", "currencyParameterId"],
          message:
            "Money unit currency parameter must name a currency parameter",
        });
      }
    }
    const calculationDependencies = new Map(
      definition.calculations.map((calculation) => [
        calculation.id,
        calculation.dependencies.filter((id) => calculationIds.has(id)),
      ]),
    );
    function hasCalculationCycle(
      id,
      visiting = new Set(),
      visited = new Set(),
    ) {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dependency of calculationDependencies.get(id) ?? []) {
        if (hasCalculationCycle(dependency, visiting, visited)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    }
    for (const [index, calculation] of definition.calculations.entries()) {
      if (hasCalculationCycle(calculation.id))
        context.addIssue({
          code: "custom",
          path: ["calculations", index, "dependencies"],
          message: `Calculation dependency cycle: ${calculation.id}`,
        });
    }
    for (const [index, column] of definition.expectedResult.columns.entries()) {
      if (
        column.unit?.currencyParameterId !== undefined &&
        (parameters.get(column.unit.currencyParameterId)?.type !== "currency" ||
          parameters.get(column.unit.currencyParameterId)?.required !== true)
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "expectedResult",
            "columns",
            index,
            "unit",
            "currencyParameterId",
          ],
          message:
            "Money unit currency parameter must name a currency parameter",
        });
      }
      if (column.calculationId !== undefined) {
        const calculation = calculations.get(column.calculationId);
        const version =
          calculation?.kind === "metric"
            ? calculation.metricVersion
            : calculation?.languageVersion;
        if (
          calculation === undefined ||
          calculation.resultType !== column.type ||
          version !== column.calculationVersion ||
          !sameUnit(calculation.unit, column.unit)
        ) {
          context.addIssue({
            code: "custom",
            path: ["expectedResult", "columns", index],
            message: "Column calculation contract differs",
          });
        }
      }
    }

    const reporting = [
      ["currencyParameterId", "currency"],
      ["timezoneParameterId", "string"],
      ["dateFromParameterId", "date"],
      ["dateToParameterId", "date"],
    ];
    for (const [role, type] of reporting) {
      const parameter = parameters.get(definition.reporting[role]);
      if (parameter === undefined)
        context.addIssue({
          code: "custom",
          path: ["reporting", role],
          message: `Unknown reporting parameter: ${definition.reporting[role]}`,
        });
      else if (!parameter.required || parameter.type !== type)
        context.addIssue({
          code: "custom",
          path: ["reporting", role],
          message: `Reporting parameter must be required ${type}`,
        });
    }

    for (const [index, presentation] of definition.presentations.entries()) {
      const requiredIds = addDuplicateIssues(
        presentation.requires.columns,
        context,
        `presentations.${index}.requires.columns`,
      );
      for (const binding of presentationBindings(presentation)) {
        if (!columnIds.has(binding))
          context.addIssue({
            code: "custom",
            path: ["presentations", index, "bindings"],
            message: `Unknown presentation binding: ${binding}`,
          });
        if (!requiredIds.has(binding))
          context.addIssue({
            code: "custom",
            path: ["presentations", index, "requires"],
            message: `Presentation binding is not required: ${binding}`,
          });
      }
      for (const required of presentation.requires.columns) {
        const expected = columns.get(required.id);
        if (expected === undefined || !sameColumn(expected, required))
          context.addIssue({
            code: "custom",
            path: ["presentations", index, "requires"],
            message: `Presentation column contract differs: ${required.id}`,
          });
      }
    }
  },
);

const sourceIdentitySchema = z
  .object({
    providerId: identifierSchema,
    sourceId: z.string().min(1).max(512),
    sourceVersion: z.string().min(1).max(256),
    asOf: dateTimeSchema,
    contentHash: hashSchema.optional(),
    uri: z.string().url().max(2_048).optional(),
    passageId: z.string().min(1).max(256).optional(),
  })
  .strict();
const sourceVersionSchema = z
  .object({
    datasetId: identifierSchema,
    schemaVersion: z.number().int().positive(),
    revision: z.string().min(1).max(256),
    capturedAt: dateTimeSchema,
  })
  .strict();
const lineageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("records"),
      datasetId: identifierSchema,
      records: z
        .array(
          z
            .object({
              entity: identifierSchema,
              id: z.string().min(1).max(256),
              source: sourceIdentitySchema.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(10_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("opaque"),
      datasetId: identifierSchema,
      token: z.string().min(1).max(1_024),
      reason: z.string().min(1).max(512),
      sources: z.array(sourceIdentitySchema).max(64).default([]),
    })
    .strict(),
]);
const rowSchema = z
  .object({
    id: z.string().min(1).max(256),
    values: z.record(z.string(), scalarSchema),
    lineage: z.array(lineageSchema).min(1).max(64),
  })
  .strict();
const windowSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("complete"),
      totalRows: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page"),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      totalRows: z.number().int().nonnegative().optional(),
      hasMore: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("truncated"),
      returnedRows: z.number().int().nonnegative(),
      rowLimit: z.number().int().positive(),
      totalRows: z.number().int().nonnegative().optional(),
      reason: z.string().min(1).max(512),
    })
    .strict(),
]);
const dataSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    rowGrain: z
      .object({
        id: identifierSchema,
        description: z.string().min(1).max(512),
        keys: z.array(identifierSchema).min(1).max(32),
      })
      .strict(),
    columns: z.array(columnSchema).min(1).max(256),
    rows: z.array(rowSchema).max(100_000),
    window: windowSchema,
  })
  .strict();
const coverageItemSchema = z
  .object({
    id: identifierSchema,
    status: z.enum(["complete", "partial", "unknown", "unavailable"]),
    reasonCode: identifierSchema.optional(),
    detail: z.string().min(1).max(1_024).optional(),
    missingRatio: decimalSchema.optional(),
    sources: z.array(sourceIdentitySchema).max(64).default([]),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (
      coverage.missingRatio !== undefined &&
      (Number(coverage.missingRatio) < 0 || Number(coverage.missingRatio) > 1)
    )
      context.addIssue({
        code: "custom",
        path: ["missingRatio"],
        message: "Missing ratio must be between zero and one",
      });
    if (
      coverage.status === "complete" &&
      coverage.missingRatio !== undefined &&
      coverage.missingRatio !== "0"
    )
      context.addIssue({
        code: "custom",
        path: ["missingRatio"],
        message: "Complete coverage cannot declare a positive missing ratio",
      });
  });
const coverageSchema = z
  .object({
    status: z.enum(["complete", "partial", "unknown", "unavailable"]),
    datasets: z.array(coverageItemSchema).min(1).max(64),
    dimensions: z.array(coverageItemSchema).max(128).default([]),
    warnings: z
      .array(
        z
          .object({
            code: identifierSchema,
            message: z.string().min(1).max(1_024),
            affectedColumns: z.array(identifierSchema).max(256).optional(),
          })
          .strict(),
      )
      .max(256)
      .default([]),
  })
  .strict();
const calculationResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      id: identifierSchema,
      status: z.literal("ok"),
      kind: z.enum(["metric", "formula"]),
      version: z.string().min(1).max(64),
      type: valueTypeSchema,
      unit: unitSchema.optional(),
      value: scalarSchema,
    })
    .strict(),
  z
    .object({
      id: identifierSchema,
      status: z.literal("error"),
      kind: z.enum(["metric", "formula"]),
      version: z.string().min(1).max(64),
      type: valueTypeSchema,
      unit: unitSchema.optional(),
      error: z
        .object({
          code: identifierSchema,
          message: z.string().min(1).max(1_024),
        })
        .strict(),
    })
    .strict(),
]);

const resultFields = {
  contractVersion: z.literal(ANALYSIS_CONTRACT_VERSION),
  runId: z.string().min(1).max(256),
  definitionRef: z
    .object({
      definitionId: identifierSchema,
      definitionVersion: z.number().int().positive(),
    })
    .strict(),
  startedAt: dateTimeSchema,
  execution: z
    .object({
      executorId: identifierSchema,
      executorVersion: z.string().min(1).max(64),
      queryMode: z.enum(["visual-plan", "custom-sql"]),
      durationMs: z.number().int().nonnegative().optional(),
      snapshot: z
        .object({
          consistency: z.enum([
            "repeatable-read",
            "frozen-inputs",
            "best-effort",
          ]),
          id: z.string().min(1).max(256),
          capturedAt: dateTimeSchema,
        })
        .strict(),
      effectiveParameters: z.record(z.string(), scalarSchema),
      effectiveAssumptions: z.record(z.string(), scalarSchema),
    })
    .strict(),
  reporting: z
    .object({
      currency: currencySchema,
      timezone: timezoneSchema,
      dateRange: z
        .object({
          from: dateSchema,
          to: dateSchema,
          bounds: z.literal("inclusive"),
        })
        .strict(),
    })
    .strict(),
  sourceVersions: z.array(sourceVersionSchema).min(1).max(64),
  calculationResults: z.array(calculationResultSchema).max(256),
  coverage: coverageSchema,
};
const resultBaseSchema = z.discriminatedUnion("status", [
  z.object({ ...resultFields, status: z.literal("queued") }).strict(),
  z.object({ ...resultFields, status: z.literal("running") }).strict(),
  z
    .object({
      ...resultFields,
      status: z.literal("partial"),
      completedAt: dateTimeSchema,
      data: dataSchema,
    })
    .strict(),
  z
    .object({
      ...resultFields,
      status: z.literal("completed"),
      completedAt: dateTimeSchema,
      data: dataSchema,
    })
    .strict(),
  z
    .object({
      ...resultFields,
      status: z.literal("failed"),
      completedAt: dateTimeSchema,
      error: z
        .object({
          code: identifierSchema,
          message: z.string().min(1).max(2_048),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...resultFields,
      status: z.literal("cancelled"),
      completedAt: dateTimeSchema,
      error: z
        .object({
          code: identifierSchema,
          message: z.string().min(1).max(2_048),
        })
        .strict(),
    })
    .strict(),
]);

export const analysisExecutionResultSchema = resultBaseSchema.superRefine(
  (result, context) => {
    const sourceIds = addDuplicateIssues(
      result.sourceVersions.map((value) => ({ id: value.datasetId })),
      context,
      "sourceVersions",
    );
    const coverageIds = addDuplicateIssues(
      result.coverage.datasets,
      context,
      "coverage.datasets",
    );
    addDuplicateIssues(
      result.coverage.dimensions,
      context,
      "coverage.dimensions",
    );
    addDuplicateIssues(
      result.calculationResults,
      context,
      "calculationResults",
    );
    if (
      sourceIds.size !== coverageIds.size ||
      [...sourceIds].some((id) => !coverageIds.has(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "datasets"],
        message: "Coverage datasets must equal source-version datasets",
      });
    }
    if (
      result.coverage.status === "complete" &&
      [...result.coverage.datasets, ...result.coverage.dimensions].some(
        (value) => value.status !== "complete",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "status"],
        message: "Complete coverage requires all entries to be complete",
      });
    }
    for (const [index, calculation] of result.calculationResults.entries()) {
      if (
        calculation.status === "ok" &&
        !valueMatchesType(calculation.value, calculation)
      ) {
        context.addIssue({
          code: "custom",
          path: ["calculationResults", index, "value"],
          message: `Calculation value does not match ${calculation.type}`,
        });
      }
    }
    if (!("data" in result)) return;

    const columnIds = addDuplicateIssues(
      result.data.columns,
      context,
      "data.columns",
    );
    const columns = new Map(
      result.data.columns.map((value) => [value.id, value]),
    );
    const rowIds = addDuplicateIssues(result.data.rows, context, "data.rows");
    void rowIds;
    for (const key of result.data.rowGrain.keys) {
      if (!columnIds.has(key))
        context.addIssue({
          code: "custom",
          path: ["data", "rowGrain", "keys"],
          message: `Unknown row-grain key: ${key}`,
        });
    }
    const grainTuples = new Set();
    for (const [rowIndex, row] of result.data.rows.entries()) {
      for (const id of columnIds) {
        if (!(id in row.values))
          context.addIssue({
            code: "custom",
            path: ["data", "rows", rowIndex, "values"],
            message: `Missing column value: ${id}`,
          });
      }
      for (const [id, value] of Object.entries(row.values)) {
        const column = columns.get(id);
        if (column === undefined)
          context.addIssue({
            code: "custom",
            path: ["data", "rows", rowIndex, "values", id],
            message: `Unknown column value: ${id}`,
          });
        else if (!valueMatchesType(value, column, column.nullable))
          context.addIssue({
            code: "custom",
            path: ["data", "rows", rowIndex, "values", id],
            message: `Value does not match ${column.type}`,
          });
      }
      for (const lineage of row.lineage) {
        if (!sourceIds.has(lineage.datasetId))
          context.addIssue({
            code: "custom",
            path: ["data", "rows", rowIndex, "lineage"],
            message: `Unknown lineage dataset: ${lineage.datasetId}`,
          });
      }
      const tuple = JSON.stringify(
        result.data.rowGrain.keys.map((key) => row.values[key]),
      );
      if (grainTuples.has(tuple))
        context.addIssue({
          code: "custom",
          path: ["data", "rows", rowIndex],
          message: "Duplicate row-grain tuple",
        });
      grainTuples.add(tuple);
    }
    for (const warning of result.coverage.warnings) {
      for (const id of warning.affectedColumns ?? []) {
        if (!columnIds.has(id))
          context.addIssue({
            code: "custom",
            path: ["coverage", "warnings"],
            message: `Unknown affected column: ${id}`,
          });
      }
    }
    const count = result.data.rows.length;
    const window = result.data.window;
    if (window.kind === "complete" && window.totalRows !== count)
      context.addIssue({
        code: "custom",
        path: ["data", "window", "totalRows"],
        message: "Complete row count must equal returned rows",
      });
    if (window.kind === "page") {
      if (count > window.limit)
        context.addIssue({
          code: "custom",
          path: ["data", "window", "limit"],
          message: "Page rows exceed its limit",
        });
      if (
        window.totalRows !== undefined &&
        (window.offset + count > window.totalRows ||
          window.hasMore !== window.offset + count < window.totalRows)
      )
        context.addIssue({
          code: "custom",
          path: ["data", "window"],
          message: "Page total and hasMore are inconsistent",
        });
      if (
        window.totalRows === undefined &&
        window.hasMore === false &&
        count === window.limit
      )
        context.addIssue({
          code: "custom",
          path: ["data", "window", "hasMore"],
          message: "A full page with unknown total cannot prove it is final",
        });
    }
    if (
      window.kind === "truncated" &&
      (window.returnedRows !== count ||
        count > window.rowLimit ||
        (window.totalRows !== undefined && window.totalRows < count))
    )
      context.addIssue({
        code: "custom",
        path: ["data", "window"],
        message: "Truncated row counts are inconsistent",
      });
  },
);

function reason(code, path, message) {
  return { code, path, message };
}
function compareExactKeys(record, declarations, requiredOnly) {
  const allowed = new Set(declarations.map((value) => value.id));
  const required = declarations
    .filter((value) => !requiredOnly || value.required)
    .map((value) => value.id);
  return {
    unknown: Object.keys(record).filter((id) => !allowed.has(id)),
    missing: required.filter((id) => !(id in record)),
  };
}

export function checkAnalysisResultCompatibility(definitionInput, resultInput) {
  const definitionParse = analysisDefinitionSchema.safeParse(definitionInput);
  const resultParse = analysisExecutionResultSchema.safeParse(resultInput);
  const reasons = [];
  if (!definitionParse.success)
    reasons.push(
      ...definitionParse.error.issues.map((entry) =>
        reason("invalid-definition", entry.path.join("."), entry.message),
      ),
    );
  if (!resultParse.success)
    reasons.push(
      ...resultParse.error.issues.map((entry) =>
        reason("invalid-result", entry.path.join("."), entry.message),
      ),
    );
  if (reasons.length > 0) return { compatible: false, reasons };
  const definition = definitionParse.data;
  const result = resultParse.data;
  if (result.definitionRef.definitionId !== definition.definitionId)
    reasons.push(
      reason(
        "definition-id-mismatch",
        "definitionRef.definitionId",
        "Result belongs to another analysis",
      ),
    );
  if (result.definitionRef.definitionVersion !== definition.definitionVersion)
    reasons.push(
      reason(
        "definition-version-mismatch",
        "definitionRef.definitionVersion",
        "Result uses another definition version",
      ),
    );
  if (
    !["completed", "partial"].includes(result.status) ||
    !("data" in result)
  ) {
    reasons.push(
      reason("result-not-readable", "status", "Result has no readable data"),
    );
    return { compatible: false, reasons };
  }
  if (result.execution.queryMode !== definition.source.kind)
    reasons.push(
      reason(
        "query-mode-mismatch",
        "execution.queryMode",
        "Executor used another source mode",
      ),
    );

  const parameterKeys = compareExactKeys(
    result.execution.effectiveParameters,
    definition.parameters,
    true,
  );
  const assumptionKeys = compareExactKeys(
    result.execution.effectiveAssumptions,
    definition.assumptions,
    false,
  );
  for (const id of [...parameterKeys.unknown, ...assumptionKeys.unknown])
    reasons.push(
      reason(
        "unknown-effective-input",
        `execution.effectiveInputs.${id}`,
        "Effective input is not declared",
      ),
    );
  for (const id of [...parameterKeys.missing, ...assumptionKeys.missing])
    reasons.push(
      reason(
        "missing-effective-input",
        `execution.effectiveInputs.${id}`,
        "Declared effective input is missing",
      ),
    );
  for (const declaration of definition.parameters) {
    if (
      declaration.id in result.execution.effectiveParameters &&
      !valueMatchesType(
        result.execution.effectiveParameters[declaration.id],
        declaration,
      )
    )
      reasons.push(
        reason(
          "effective-input-type-mismatch",
          `execution.effectiveParameters.${declaration.id}`,
          "Effective parameter has the wrong type",
        ),
      );
  }
  for (const declaration of definition.assumptions) {
    if (
      declaration.id in result.execution.effectiveAssumptions &&
      !valueMatchesType(
        result.execution.effectiveAssumptions[declaration.id],
        declaration,
      )
    )
      reasons.push(
        reason(
          "effective-input-type-mismatch",
          `execution.effectiveAssumptions.${declaration.id}`,
          "Effective assumption has the wrong type",
        ),
      );
  }
  const effective = result.execution.effectiveParameters;
  if (
    effective[definition.reporting.currencyParameterId] !==
      result.reporting.currency ||
    effective[definition.reporting.timezoneParameterId] !==
      result.reporting.timezone ||
    effective[definition.reporting.dateFromParameterId] !==
      result.reporting.dateRange.from ||
    effective[definition.reporting.dateToParameterId] !==
      result.reporting.dateRange.to
  )
    reasons.push(
      reason(
        "reporting-scope-mismatch",
        "reporting",
        "Reporting scope differs from effective parameters",
      ),
    );

  const expectedDatasets = new Map(
    definition.datasets.map((value) => [value.id, value.schemaVersion]),
  );
  const actualDatasets = new Map(
    result.sourceVersions.map((value) => [
      value.datasetId,
      value.schemaVersion,
    ]),
  );
  for (const [id, version] of expectedDatasets)
    if (actualDatasets.get(id) !== version)
      reasons.push(
        reason(
          "dataset-version-mismatch",
          `sourceVersions.${id}`,
          "Dataset schema version differs",
        ),
      );
  for (const id of actualDatasets.keys())
    if (!expectedDatasets.has(id))
      reasons.push(
        reason(
          "unexpected-dataset",
          `sourceVersions.${id}`,
          "Result contains an undeclared dataset",
        ),
      );

  const actualCalculations = new Map(
    result.calculationResults.map((value) => [value.id, value]),
  );
  for (const calculation of definition.calculations) {
    const actual = actualCalculations.get(calculation.id);
    const version =
      calculation.kind === "metric"
        ? calculation.metricVersion
        : calculation.languageVersion;
    if (actual === undefined)
      reasons.push(
        reason(
          "missing-calculation-result",
          `calculationResults.${calculation.id}`,
          "Calculation result is missing",
        ),
      );
    else if (
      actual.kind !== calculation.kind ||
      actual.version !== version ||
      actual.type !== calculation.resultType ||
      !sameUnit(actual.unit, calculation.unit)
    )
      reasons.push(
        reason(
          "calculation-contract-mismatch",
          `calculationResults.${calculation.id}`,
          "Calculation result contract differs",
        ),
      );
    else if (actual.status === "error")
      reasons.push(
        reason(
          "calculation-error",
          `calculationResults.${calculation.id}`,
          "Calculation did not produce a value",
        ),
      );
  }
  for (const id of actualCalculations.keys())
    if (!definition.calculations.some((value) => value.id === id))
      reasons.push(
        reason(
          "unexpected-calculation",
          `calculationResults.${id}`,
          "Result contains an undeclared calculation",
        ),
      );

  const actualColumns = new Map(
    result.data.columns.map((value) => [value.id, value]),
  );
  for (const expected of definition.expectedResult.columns) {
    const actual = actualColumns.get(expected.id);
    if (actual === undefined)
      reasons.push(
        reason(
          "missing-column",
          `data.columns.${expected.id}`,
          "Required result column is missing",
        ),
      );
    else if (!sameColumn(actual, expected))
      reasons.push(
        reason(
          "column-contract-mismatch",
          `data.columns.${expected.id}`,
          "Result column contract differs",
        ),
      );
  }
  for (const presentation of definition.presentations) {
    if (
      presentation.requires.completeResult &&
      (result.status !== "completed" ||
        result.coverage.status !== "complete" ||
        result.data.window.kind !== "complete")
    )
      reasons.push(
        reason(
          "incomplete-presentation-input",
          `presentations.${presentation.id}`,
          "Presentation requires complete, untruncated data",
        ),
      );
    for (const required of presentation.requires.columns) {
      const actual = actualColumns.get(required.id);
      if (actual === undefined || !sameColumn(actual, required))
        reasons.push(
          reason(
            "incompatible-presentation-column",
            `presentations.${presentation.id}.${required.id}`,
            "Presentation input is missing or incompatible",
          ),
        );
    }
  }
  return reasons.length === 0
    ? { compatible: true }
    : { compatible: false, reasons };
}
