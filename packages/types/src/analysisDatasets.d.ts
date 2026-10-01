export declare const ANALYSIS_DATASET_CATALOG_VERSION: 1;

export interface AnalysisDatasetJoinPath {
  id: string;
  toDatasetId: string;
  cardinality: "many-to-one";
  fields: string[];
}

export interface AnalysisDatasetDescriptor {
  id:
    | "transactions"
    | "accounts"
    | "holdings"
    | "cash-flows"
    | "positions"
    | "cost-basis"
    | "portfolio-history"
    | "broker-history"
    | "fx-history"
    | "benchmark-history";
  schemaVersion: 1;
  relation: string;
  grain: string;
  authorizationScope: "local-user-database";
  timeBasis: string;
  currencySemantics: string;
  signSemantics: string;
  coverage: string;
  primaryKey: string[];
  joinPaths: AnalysisDatasetJoinPath[];
}

export declare const ANALYSIS_DATASETS_V1: readonly AnalysisDatasetDescriptor[];
export declare const ANALYSIS_FINANCIAL_DATASETS_V1: readonly AnalysisDatasetDescriptor[];

export declare function getAnalysisDataset(
  id: string,
  schemaVersion?: number,
): AnalysisDatasetDescriptor | undefined;

export declare function assertAnalysisDatasetReference(reference: {
  id: string;
  schemaVersion: number;
  authorizationScope: string;
  requiredColumns?: string[];
}): AnalysisDatasetDescriptor;
