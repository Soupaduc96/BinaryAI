import type { SimulationModel, SimulationModelStatus, SimulationParameters } from '@binaryai/types';
import type { Row, SqlExecutor } from '../executor.js';
import { fromJson, toEpochMs, toText } from '../mappers.js';

/**
 * The simulation-model catalogue.
 *
 * READ-MOSTLY BY DESIGN. Models are published by migration and reviewed in
 * version control alongside the constraints that bound them; there is no
 * create/update path exposed to the application, and none to any HTTP route.
 * That is what makes "a client cannot author the accounting model" a property
 * of the system rather than a rule somebody has to remember.
 *
 * The database enforces the rest: (model_key, version) is unique, published
 * rows are immutable, and the parameter shape is checked. See migration 0009.
 */

interface ModelRow extends Row {
  id: string;
  model_key: string;
  version: string;
  name: string;
  description: string;
  parameters: unknown;
  status: string;
  effective_at: Date;
  created_at: Date;
}

const COLUMNS = `id, model_key, version, name, description, parameters, status,
                 effective_at, created_at`;

function toStatus(value: string): SimulationModelStatus {
  if (value === 'draft' || value === 'active' || value === 'deprecated') return value;
  // Unreachable while the CHECK stands. Failing loudly beats treating an
  // unrecognised status as active and settling positions against it.
  throw new Error(`Unknown simulation model status: ${value}`);
}

function toModel(row: ModelRow): SimulationModel {
  const parameters = fromJson<Partial<SimulationParameters>>(row.parameters, {});
  return {
    id: toText(row.id, 'simulation_model.id'),
    modelKey: toText(row.model_key, 'simulation_model.model_key'),
    version: toText(row.version, 'simulation_model.version'),
    name: toText(row.name, 'simulation_model.name'),
    description: toText(row.description, 'simulation_model.description'),
    parameters: {
      startingUnits: Number(parameters.startingUnits),
      simulatedReturnRate: Number(parameters.simulatedReturnRate),
      lossRule: parameters.lossRule === 'partial_refund' ? 'partial_refund' : 'forfeit_exposure',
      lossRefundRate: Number(parameters.lossRefundRate ?? 0),
      tieRule: parameters.tieRule === 'treat_as_loss' ? 'treat_as_loss' : 'refund_exposure',
      roundingDecimals: Number(parameters.roundingDecimals ?? 8),
      settlementRule: String(parameters.settlementRule ?? 'unspecified'),
    },
    status: toStatus(toText(row.status, 'simulation_model.status')),
    effectiveAt: toEpochMs(row.effective_at, 'simulation_model.effective_at'),
    createdAt: toEpochMs(row.created_at, 'simulation_model.created_at'),
  };
}

export interface SimulationModelRepository {
  /** Models a user may select. Deprecated and draft models are excluded. */
  listSelectable(): Promise<readonly SimulationModel[]>;
  /** Any model by id, including deprecated ones, so settled positions stay readable. */
  findById(id: string): Promise<SimulationModel | null>;
  findByKeyAndVersion(modelKey: string, version: string): Promise<SimulationModel | null>;
}

export function createSimulationModelRepository(executor: SqlExecutor): SimulationModelRepository {
  return {
    async listSelectable() {
      const result = await executor.query<ModelRow>(
        `SELECT ${COLUMNS} FROM simulation_models
          WHERE status = 'active'
          ORDER BY model_key ASC, effective_at DESC`,
      );
      return result.rows.map(toModel);
    },

    async findById(id) {
      // Deliberately not filtered by status. A position settled under a model
      // that was later deprecated must still be explainable, and hiding the
      // model would leave a stamped ledger entry pointing at nothing.
      const result = await executor.query<ModelRow>(
        `SELECT ${COLUMNS} FROM simulation_models WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toModel(row) : null;
    },

    async findByKeyAndVersion(modelKey, version) {
      const result = await executor.query<ModelRow>(
        `SELECT ${COLUMNS} FROM simulation_models WHERE model_key = $1 AND version = $2`,
        [modelKey, version],
      );
      const row = result.rows[0];
      return row ? toModel(row) : null;
    },
  };
}
