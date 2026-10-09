import { z } from 'zod';
import { workItemIdSchema } from './ids.js';

/** The longest text the map format allows (`concurrency-schema.ts`), so any valid map is served. */
const MAP_TEXT = 16000;

/** A position in a roadmap graph's `nodes`: the board and graph refer to nodes by index. */
const nodeIndex = z.number().int().nonnegative();

/**
 * A roadmap's dependency structure at one definition revision (R-E3b): what the board and its
 * graph draw. A revision never changes, so this is read once per revision
 * (`…/roadmaps/:id/graph/:revision`) and never invalidated. Requirements are node indices.
 *
 * A map roadmap's nodes are the map's milestones (a work item's acceptance, each slice's
 * started, merged and verified, each checkpoint), with the requirements the map declares; a
 * sequential roadmap's are its work items, with their dependencies.
 */
export const roadmapGraphSchema = z
  .strictObject({
    roadmapId: z.string().uuid(),
    revision: z.number().int().positive(),
    model: z.enum(['map', 'sequence']),
    /** The board's lanes: a map's repositories, or a sequence's projects. */
    lanes: z.array(
      z.strictObject({ key: z.string().max(MAP_TEXT), label: z.string().max(MAP_TEXT) }),
    ),
    nodes: z.array(
      z.strictObject({
        key: z.string().max(MAP_TEXT + 100),
        kind: z.enum(['work_item', 'slice', 'checkpoint']),
        sourceId: z.string().max(MAP_TEXT),
        state: z.enum(['accepted', 'started', 'merged', 'verified', 'passed', 'completed']),
        title: z.string().max(MAP_TEXT),
        /** The node's lane; checkpoints have none. */
        lane: nodeIndex.optional(),
        /** A slice's work item. */
        parent: nodeIndex.optional(),
        /** What the node requires, as declared. */
        requires: z.array(nodeIndex),
        /** Whether the roadmap's selection includes it. */
        included: z.boolean(),
        /** A work item's id; a slice's is its parent's. */
        workItemId: workItemIdSchema.optional(),
        /** A checkpoint's kind, as the map names it (`architecture_decision`, `contract`, …). */
        checkpointKind: z.string().max(MAP_TEXT).optional(),
      }),
    ),
  })
  .superRefine((graph, context) => {
    const inRange = (index: number | undefined, list: number) =>
      index === undefined || index < list;
    for (const node of graph.nodes)
      if (
        !inRange(node.lane, graph.lanes.length) ||
        !inRange(node.parent, graph.nodes.length) ||
        node.requires.some((r) => !inRange(r, graph.nodes.length))
      )
        context.addIssue({ code: 'custom', message: `Node ${node.key} names no such node.` });
  });
export type RoadmapGraph = z.infer<typeof roadmapGraphSchema>;
export type RoadmapGraphNode = RoadmapGraph['nodes'][number];

/**
 * A roadmap's board at one read (R-E3b), beside its status list: every node's state as the
 * daemon recorded it, by index into the graph of `revision`. The browser lays it out and
 * traverses it for drawing; every state, actor and count here is the daemon's.
 */
export const roadmapBoardSchema = z.strictObject({
  /** The definition revision whose graph the indices refer to. */
  revision: z.number().int().positive(),
  /** The status strip: the status list's entries by who acts next, and the completed ones. */
  summary: z.strictObject({
    needsYou: z.number().int().nonnegative(),
    agentsAtWork: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
  /** One per graph node, in the graph's order. */
  nodes: z.array(
    z.strictObject({
      satisfied: z.boolean(),
      /**
       * The roadmap entries working toward this node, as positions in the entries of the
       * definition at `revision`; the status list says where each is.
       */
      entries: z.array(z.number().int().nonnegative()).optional(),
      /** An open inbox item for this node (a checkpoint's). */
      attentionItemId: z.string().optional(),
      /** The run at work on it, while one is. */
      runId: z.string().optional(),
      /** Its unmet requirements, as the daemon evaluates them. */
      unmet: z.array(nodeIndex).optional(),
      /** The unmet nodes upstream that have no unmet requirements of their own. */
      roots: z.array(nodeIndex).optional(),
      /**
       * The unfinished, selected slices waiting on it, one node per slice: its first unmet
       * milestone.
       */
      unblocks: z.array(nodeIndex).optional(),
    }),
  ),
  /**
   * The unsatisfied, selected checkpoints that slices wait on, most slices unblocked first, with
   * how many (`slicesWaitingOn`), and the open inbox item for each.
   */
  gates: z.array(
    z.strictObject({
      node: nodeIndex,
      slices: z.number().int().positive(),
      attentionItemId: z.string().optional(),
    }),
  ),
  /** Each lane's cards in roadmap priority order, open ones apart from completed ones. */
  lanes: z.array(
    z.strictObject({
      lane: nodeIndex,
      cards: z.array(
        z.strictObject({
          node: nodeIndex,
          /** How many unsatisfied checkpoints the card's work waits on directly. */
          gates: z.number().int().nonnegative(),
        }),
      ),
      done: z.array(nodeIndex),
    }),
  ),
});
export type RoadmapBoard = z.infer<typeof roadmapBoardSchema>;
