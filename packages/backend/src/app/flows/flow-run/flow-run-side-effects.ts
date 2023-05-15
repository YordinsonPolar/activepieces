import { isNil } from 'lodash'
import dayjs from 'dayjs'
import { ActivepiecesError, ErrorCode, ExecutionType, FlowRun, PauseType } from '@activepieces/shared'
import { JobType, flowQueue } from '../../workers/flow-worker/flow-queue'
import { logger } from '../../helper/logger'

type StartParams = {
    flowRun: FlowRun
    executionType: ExecutionType
    payload: unknown
}

type PauseParams = {
    flowRun: FlowRun
}

const calculateDelayForResumeJob = (resumeDateTimeIsoString: string): number => {
    const now = dayjs()
    const resumeDateTime = dayjs(resumeDateTimeIsoString)
    const delayInMilliSeconds = resumeDateTime.diff(now)
    const resumeDateTimeAlreadyPassed = delayInMilliSeconds < 0

    if (resumeDateTimeAlreadyPassed) {
        return 0
    }

    return delayInMilliSeconds
}

export const flowRunSideEffects = {
    async start({ flowRun, executionType, payload }: StartParams): Promise<void> {
        logger.warn(`[FlowRunSideEffects#start] flowRunId=${flowRun.id} executionType=${executionType}`)

        await flowQueue.add({
            id: flowRun.id,
            type: JobType.ONE_TIME,
            data: {
                projectId: flowRun.projectId,
                environment: flowRun.environment,
                runId: flowRun.id,
                flowVersionId: flowRun.flowVersionId,
                payload,
                executionType,
            },
        })
    },

    async pause({ flowRun }: PauseParams): Promise<void> {
        logger.warn(`[FlowRunSideEffects#pause] flowRunId=${flowRun.id} pauseType=${flowRun.pauseMetadata?.type}`)

        const { pauseMetadata } = flowRun

        if (isNil(pauseMetadata)) {
            throw new ActivepiecesError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: `pauseMetadata is undefined flowRunId=${flowRun.id}`,
                },
            })
        }

        if (pauseMetadata.type === PauseType.DELAY) {
            await flowQueue.add({
                id: flowRun.id,
                type: JobType.DELAYED,
                data: {
                    runId: flowRun.id,
                    projectId: flowRun.projectId,
                    environment: flowRun.environment,
                    executionType: ExecutionType.RESUME,
                    flowVersionId: flowRun.flowVersionId,
                },
                delay: calculateDelayForResumeJob(pauseMetadata.resumeDateTime),
            })
        }
    },
}
