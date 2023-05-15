import {
    apId,
    Cursor,
    ExecutionOutputStatus,
    FileId,
    FlowRun,
    FlowRunId,
    FlowVersionId,
    ProjectId,
    SeekPage,
    RunEnvironment,
    TelemetryEventName,
    ApEdition,
    FlowId,
    spreadIfDefined,
    PauseMetadata,
    ActivepiecesError,
    ErrorCode,
    ExecutionType,
} from '@activepieces/shared'
import { getEdition } from '../../helper/secret-helper'
import { databaseConnection } from '../../database/database-connection'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { Order } from '../../helper/pagination/paginator'
import { telemetry } from '../../helper/telemetry.utils'
import { FlowRunEntity } from './flow-run-entity'
import { flowRunSideEffects } from './flow-run-side-effects'
import { usageService } from '@ee/billing/backend/usage.service'
import { logger } from '../../helper/logger'
import { notifications } from '../../helper/notifications'
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity'
import { flowService } from '../flow/flow.service'
import { isNil } from 'lodash'


export const repo = databaseConnection.getRepository(FlowRunEntity)

const getFlowRunOrCreate = async (params: GetOrCreateParams): Promise<Partial<FlowRun>> => {
    const { id, projectId, flowId, flowVersionId, flowDisplayName, environment } = params

    if (id) {
        return await flowRunService.getOneOrThrow({
            id,
            projectId,
        })
    }

    return {
        id: apId(),
        projectId,
        flowId,
        flowVersionId,
        environment,
        flowDisplayName,
        startTime: new Date().toISOString(),
    }
}

export const flowRunService = {
    async list({ projectId, flowId, status, cursor, limit }: ListParams): Promise<SeekPage<FlowRun>> {
        const decodedCursor = paginationHelper.decodeCursor(cursor)
        const paginator = buildPaginator({
            entity: FlowRunEntity,
            query: {
                limit,
                order: Order.DESC,
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })

        const query = repo.createQueryBuilder('flow_run').where({
            projectId,
            ...spreadIfDefined('flowId', flowId),
            ...spreadIfDefined('status', status),
            environment: RunEnvironment.PRODUCTION,
        })

        const { data, cursor: newCursor } = await paginator.paginate(query)
        return paginationHelper.createPage<FlowRun>(data, newCursor)
    },

    async finish(
        flowRunId: FlowRunId,
        status: ExecutionOutputStatus,
        logsFileId: FileId | null,
        tasks: number,
    ): Promise<FlowRun> {
        await repo.update(flowRunId, {
            logsFileId,
            status,
            finishTime: new Date().toISOString(),
        })
        const flowRun = (await this.getOne({ id: flowRunId, projectId: undefined }))!
        const edition = await getEdition()
        if (edition === ApEdition.ENTERPRISE) {
            await usageService.addTasksConsumed({
                projectId: flowRun.projectId,
                tasks: tasks,
            })
        }
        notifications.notifyRun({
            flowRun: flowRun,
        })
        return flowRun
    },

    async start({ projectId, flowVersionId, flowRunId, payload, environment, executionType }: StartParams): Promise<FlowRun> {
        logger.warn(`[flowRunService#start]  flowVersionId=${flowVersionId} flowRunId=${flowRunId} executionType=${executionType}`)
        logger.info(`[flowRunService#start]  flowVersionId=${flowVersionId}`)

        const flowVersion = await flowVersionService.getOneOrThrow(flowVersionId)

        const flow = await flowService.getOneOrThrow({
            id: flowVersion.flowId,
            projectId,
        })

        await usageService.limit({
            projectId: flow.projectId,
            flowVersion,
        })

        const flowRun = await getFlowRunOrCreate({
            id: flowRunId,
            projectId: flow.projectId,
            flowId: flowVersion.flowId,
            flowVersionId: flowVersion.id,
            environment: environment,
            flowDisplayName: flowVersion.displayName,
        })

        flowRun.status = ExecutionOutputStatus.RUNNING

        const savedFlowRun = await repo.save(flowRun)

        telemetry.trackProject(flow.projectId, {
            name: TelemetryEventName.FLOW_RUN_CREATED,
            payload: {
                projectId: savedFlowRun.projectId,
                flowId: savedFlowRun.flowId,
                environment: savedFlowRun.environment,
            },
        })

        await flowRunSideEffects.start({
            flowRun: savedFlowRun,
            payload,
            executionType,
        })

        return savedFlowRun
    },

    async pause(params: PauseParams): Promise<void> {
        logger.warn(`[FlowRunService#pause] flowRunId=${params.flowRunId} pauseType=${params.pauseMetadata.type}`)

        logger.debug(params, '[FlowRunService#pause] params')

        const { flowRunId, pauseMetadata } = params

        await repo.update(flowRunId, {
            status: ExecutionOutputStatus.PAUSED,
            pauseMetadata: pauseMetadata as QueryDeepPartialEntity<PauseMetadata>,
        })

        const flowRun = await repo.findOneByOrFail({ id: flowRunId })

        await flowRunSideEffects.pause({ flowRun })
    },

    async getOne({ projectId, id }: GetOneParams): Promise<FlowRun | null> {
        return await repo.findOneBy({
            projectId,
            id,
        })
    },

    async getOneOrThrow(params: GetOneParams): Promise<FlowRun> {
        const flowRun = await this.getOne(params)

        if (isNil(flowRun)) {
            throw new ActivepiecesError({
                code: ErrorCode.FLOW_RUN_NOT_FOUND,
                params: {
                    id: params.id,
                },
            })
        }

        return flowRun
    },
}

type GetOrCreateParams = {
    id?: FlowRunId
    projectId: ProjectId
    flowId: FlowId
    flowVersionId: FlowVersionId
    flowDisplayName: string
    environment: RunEnvironment
}

type ListParams = {
    projectId: ProjectId
    flowId: FlowId | undefined
    status: ExecutionOutputStatus | undefined
    cursor: Cursor | null
    limit: number
}

type GetOneParams = {
    id: FlowRunId
    projectId: ProjectId | undefined
}

type StartParams = {
    projectId: ProjectId
    flowVersionId: FlowVersionId
    flowRunId?: FlowRunId
    environment: RunEnvironment
    payload: unknown
    executionType: ExecutionType
}

type PauseParams = {
    flowRunId: FlowRunId
    pauseMetadata: PauseMetadata
}
