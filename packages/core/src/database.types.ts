/**
 * GENERATED FILE — regenerate with `pnpm db:types`.
 *
 * These types mirror the local database exactly, which is why the write path can be typed at all.
 * Edit the migrations, never this file.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      agent_versions: {
        Row: {
          agent_id: string;
          agent_version_id: string;
          approved_at: string | null;
          build_manifest_json: Json;
          code_path: string;
          created_at: string;
          git_commit_sha: string | null;
          parent_agent_version_id: string | null;
          spec_id: string;
          status: string;
          version_no: number;
          whiteboard_id: string;
        };
        Insert: {
          agent_id: string;
          agent_version_id?: string;
          approved_at?: string | null;
          build_manifest_json?: Json;
          code_path: string;
          created_at?: string;
          git_commit_sha?: string | null;
          parent_agent_version_id?: string | null;
          spec_id: string;
          status?: string;
          version_no: number;
          whiteboard_id: string;
        };
        Update: {
          agent_id?: string;
          agent_version_id?: string;
          approved_at?: string | null;
          build_manifest_json?: Json;
          code_path?: string;
          created_at?: string;
          git_commit_sha?: string | null;
          parent_agent_version_id?: string | null;
          spec_id?: string;
          status?: string;
          version_no?: number;
          whiteboard_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'fk_agent_versions_agent_lineage';
            columns: ['agent_id', 'whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['agent_id', 'whiteboard_id'];
          },
          {
            foreignKeyName: 'fk_agent_versions_parent_same_agent';
            columns: ['parent_agent_version_id', 'agent_id'];
            isOneToOne: false;
            referencedRelation: 'agent_versions';
            referencedColumns: ['agent_version_id', 'agent_id'];
          },
          {
            foreignKeyName: 'fk_agent_versions_spec_lineage';
            columns: ['spec_id', 'whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'frozen_specs';
            referencedColumns: ['spec_id', 'whiteboard_id'];
          },
        ];
      };
      agents: {
        Row: {
          active_agent_version_id: string | null;
          agent_id: string;
          created_at: string;
          deployment_key: string;
          name: string;
          status: string;
          updated_at: string;
          whiteboard_id: string;
        };
        Insert: {
          active_agent_version_id?: string | null;
          agent_id?: string;
          created_at?: string;
          deployment_key: string;
          name: string;
          status?: string;
          updated_at?: string;
          whiteboard_id: string;
        };
        Update: {
          active_agent_version_id?: string | null;
          agent_id?: string;
          created_at?: string;
          deployment_key?: string;
          name?: string;
          status?: string;
          updated_at?: string;
          whiteboard_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'agents_whiteboard_id_fkey';
            columns: ['whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'whiteboards';
            referencedColumns: ['whiteboard_id'];
          },
          {
            foreignKeyName: 'fk_agents_active_version';
            columns: ['active_agent_version_id', 'agent_id'];
            isOneToOne: false;
            referencedRelation: 'agent_versions';
            referencedColumns: ['agent_version_id', 'agent_id'];
          },
        ];
      };
      comments: {
        Row: {
          anchor_field_path: string | null;
          anchor_id: string | null;
          anchor_type: string;
          author_type: string;
          author_user_id: string | null;
          body: string;
          comment_id: string;
          created_at: string;
          issue_key: string | null;
          metadata_json: Json;
          parent_comment_id: string | null;
          resolved_at: string | null;
          review_session_id: string;
          severity: string | null;
          status: string | null;
          suggested_patch_json: Json | null;
          thread_id: string;
          whiteboard_id: string;
        };
        Insert: {
          anchor_field_path?: string | null;
          anchor_id?: string | null;
          anchor_type: string;
          author_type: string;
          author_user_id?: string | null;
          body: string;
          comment_id?: string;
          created_at?: string;
          issue_key?: string | null;
          metadata_json?: Json;
          parent_comment_id?: string | null;
          resolved_at?: string | null;
          review_session_id: string;
          severity?: string | null;
          status?: string | null;
          suggested_patch_json?: Json | null;
          thread_id: string;
          whiteboard_id: string;
        };
        Update: {
          anchor_field_path?: string | null;
          anchor_id?: string | null;
          anchor_type?: string;
          author_type?: string;
          author_user_id?: string | null;
          body?: string;
          comment_id?: string;
          created_at?: string;
          issue_key?: string | null;
          metadata_json?: Json;
          parent_comment_id?: string | null;
          resolved_at?: string | null;
          review_session_id?: string;
          severity?: string | null;
          status?: string | null;
          suggested_patch_json?: Json | null;
          thread_id?: string;
          whiteboard_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comments_whiteboard_id_fkey';
            columns: ['whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'whiteboards';
            referencedColumns: ['whiteboard_id'];
          },
          {
            foreignKeyName: 'fk_comments_parent_board';
            columns: ['parent_comment_id', 'whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'comments';
            referencedColumns: ['comment_id', 'whiteboard_id'];
          },
          {
            foreignKeyName: 'fk_comments_parent_thread';
            columns: ['parent_comment_id', 'thread_id'];
            isOneToOne: false;
            referencedRelation: 'comments';
            referencedColumns: ['comment_id', 'thread_id'];
          },
          {
            foreignKeyName: 'fk_comments_session_board';
            columns: ['review_session_id', 'whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'review_sessions';
            referencedColumns: ['review_session_id', 'whiteboard_id'];
          },
        ];
      };
      execution_actions: {
        Row: {
          action_type: string;
          attempt_count: number;
          completed_at: string | null;
          created_at: string;
          dispatched_at: string | null;
          execution_action_id: string;
          execution_id: string;
          idempotency_key: string;
          marker_token: string;
          provider_action_id: string | null;
          provider_response_json: Json | null;
          reconciliation_json: Json | null;
          request_payload_json: Json;
          status: string;
          step_execution_id: string | null;
        };
        Insert: {
          action_type: string;
          attempt_count?: number;
          completed_at?: string | null;
          created_at?: string;
          dispatched_at?: string | null;
          execution_action_id?: string;
          execution_id: string;
          idempotency_key: string;
          marker_token: string;
          provider_action_id?: string | null;
          provider_response_json?: Json | null;
          reconciliation_json?: Json | null;
          request_payload_json?: Json;
          status?: string;
          step_execution_id?: string | null;
        };
        Update: {
          action_type?: string;
          attempt_count?: number;
          completed_at?: string | null;
          created_at?: string;
          dispatched_at?: string | null;
          execution_action_id?: string;
          execution_id?: string;
          idempotency_key?: string;
          marker_token?: string;
          provider_action_id?: string | null;
          provider_response_json?: Json | null;
          reconciliation_json?: Json | null;
          request_payload_json?: Json;
          status?: string;
          step_execution_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'execution_actions_execution_id_fkey';
            columns: ['execution_id'];
            isOneToOne: false;
            referencedRelation: 'executions';
            referencedColumns: ['execution_id'];
          },
          {
            foreignKeyName: 'fk_execution_actions_step';
            columns: ['step_execution_id', 'execution_id'];
            isOneToOne: false;
            referencedRelation: 'execution_steps';
            referencedColumns: ['step_execution_id', 'execution_id'];
          },
        ];
      };
      execution_events: {
        Row: {
          created_at: string;
          event_id: number;
          event_key: string | null;
          event_type: string;
          execution_action_id: string | null;
          execution_id: string;
          idempotency_key: string | null;
          payload_json: Json;
          step_execution_id: string | null;
          storage_path: string | null;
        };
        Insert: {
          created_at?: string;
          event_id?: never;
          event_key?: string | null;
          event_type: string;
          execution_action_id?: string | null;
          execution_id: string;
          idempotency_key?: string | null;
          payload_json: Json;
          step_execution_id?: string | null;
          storage_path?: string | null;
        };
        Update: {
          created_at?: string;
          event_id?: never;
          event_key?: string | null;
          event_type?: string;
          execution_action_id?: string | null;
          execution_id?: string;
          idempotency_key?: string | null;
          payload_json?: Json;
          step_execution_id?: string | null;
          storage_path?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'execution_events_execution_id_fkey';
            columns: ['execution_id'];
            isOneToOne: false;
            referencedRelation: 'executions';
            referencedColumns: ['execution_id'];
          },
          {
            foreignKeyName: 'fk_execution_events_action';
            columns: ['execution_action_id', 'execution_id'];
            isOneToOne: false;
            referencedRelation: 'execution_actions';
            referencedColumns: ['execution_action_id', 'execution_id'];
          },
          {
            foreignKeyName: 'fk_execution_events_step';
            columns: ['step_execution_id', 'execution_id'];
            isOneToOne: false;
            referencedRelation: 'execution_steps';
            referencedColumns: ['step_execution_id', 'execution_id'];
          },
        ];
      };
      execution_steps: {
        Row: {
          attempt_no: number;
          completed_at: string | null;
          error_json: Json | null;
          execution_id: string;
          input_summary_json: Json;
          node_id: string | null;
          output_summary_json: Json;
          sequence_no: number;
          started_at: string | null;
          status: string;
          step_execution_id: string;
          step_instance_key: string;
          step_key: string;
        };
        Insert: {
          attempt_no?: number;
          completed_at?: string | null;
          error_json?: Json | null;
          execution_id: string;
          input_summary_json?: Json;
          node_id?: string | null;
          output_summary_json?: Json;
          sequence_no: number;
          started_at?: string | null;
          status?: string;
          step_execution_id?: string;
          step_instance_key: string;
          step_key: string;
        };
        Update: {
          attempt_no?: number;
          completed_at?: string | null;
          error_json?: Json | null;
          execution_id?: string;
          input_summary_json?: Json;
          node_id?: string | null;
          output_summary_json?: Json;
          sequence_no?: number;
          started_at?: string | null;
          status?: string;
          step_execution_id?: string;
          step_instance_key?: string;
          step_key?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'execution_steps_execution_id_fkey';
            columns: ['execution_id'];
            isOneToOne: false;
            referencedRelation: 'executions';
            referencedColumns: ['execution_id'];
          },
        ];
      };
      executions: {
        Row: {
          agent_id: string;
          agent_version_id: string;
          business_key: string | null;
          case_key: string;
          completed_at: string | null;
          created_at: string;
          diff_summary_json: Json | null;
          error_json: Json | null;
          execution_id: string;
          expected_summary_json: Json | null;
          idempotency_key: string;
          input_ref_json: Json;
          output_summary_json: Json | null;
          run_type: string;
          started_at: string | null;
          status: string;
          temporal_run_id: string | null;
          temporal_workflow_id: string | null;
        };
        Insert: {
          agent_id: string;
          agent_version_id: string;
          business_key?: string | null;
          case_key: string;
          completed_at?: string | null;
          created_at?: string;
          diff_summary_json?: Json | null;
          error_json?: Json | null;
          execution_id?: string;
          expected_summary_json?: Json | null;
          idempotency_key: string;
          input_ref_json?: Json;
          output_summary_json?: Json | null;
          run_type: string;
          started_at?: string | null;
          status?: string;
          temporal_run_id?: string | null;
          temporal_workflow_id?: string | null;
        };
        Update: {
          agent_id?: string;
          agent_version_id?: string;
          business_key?: string | null;
          case_key?: string;
          completed_at?: string | null;
          created_at?: string;
          diff_summary_json?: Json | null;
          error_json?: Json | null;
          execution_id?: string;
          expected_summary_json?: Json | null;
          idempotency_key?: string;
          input_ref_json?: Json;
          output_summary_json?: Json | null;
          run_type?: string;
          started_at?: string | null;
          status?: string;
          temporal_run_id?: string | null;
          temporal_workflow_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'fk_executions_version_agent';
            columns: ['agent_version_id', 'agent_id'];
            isOneToOne: false;
            referencedRelation: 'agent_versions';
            referencedColumns: ['agent_version_id', 'agent_id'];
          },
        ];
      };
      frozen_specs: {
        Row: {
          created_at: string;
          created_by: string;
          source_canvas_hash: string;
          source_canvas_json: Json;
          source_revision_no: number;
          spec_hash: string;
          spec_id: string;
          spec_json: Json;
          spec_version: number;
          unresolved_comment_ids: string[];
          whiteboard_id: string;
        };
        Insert: {
          created_at?: string;
          created_by: string;
          source_canvas_hash: string;
          source_canvas_json: Json;
          source_revision_no: number;
          spec_hash: string;
          spec_id?: string;
          spec_json: Json;
          spec_version: number;
          unresolved_comment_ids?: string[];
          whiteboard_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          source_canvas_hash?: string;
          source_canvas_json?: Json;
          source_revision_no?: number;
          spec_hash?: string;
          spec_id?: string;
          spec_json?: Json;
          spec_version?: number;
          unresolved_comment_ids?: string[];
          whiteboard_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'frozen_specs_whiteboard_id_fkey';
            columns: ['whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'whiteboards';
            referencedColumns: ['whiteboard_id'];
          },
        ];
      };
      review_sessions: {
        Row: {
          completed_at: string | null;
          created_at: string;
          error_json: Json | null;
          model_name: string;
          reasoning_effort: string;
          requested_by: string;
          review_session_id: string;
          review_summary_json: Json;
          round_no: number;
          source_canvas_hash: string;
          source_canvas_json: Json;
          source_revision_no: number;
          status: string;
          whiteboard_id: string;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          error_json?: Json | null;
          model_name?: string;
          reasoning_effort?: string;
          requested_by: string;
          review_session_id?: string;
          review_summary_json?: Json;
          round_no: number;
          source_canvas_hash: string;
          source_canvas_json: Json;
          source_revision_no: number;
          status?: string;
          whiteboard_id: string;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          error_json?: Json | null;
          model_name?: string;
          reasoning_effort?: string;
          requested_by?: string;
          review_session_id?: string;
          review_summary_json?: Json;
          round_no?: number;
          source_canvas_hash?: string;
          source_canvas_json?: Json;
          source_revision_no?: number;
          status?: string;
          whiteboard_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'review_sessions_whiteboard_id_fkey';
            columns: ['whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'whiteboards';
            referencedColumns: ['whiteboard_id'];
          },
        ];
      };
      whiteboard_edges: {
        Row: {
          condition_json: Json | null;
          created_at: string;
          edge_id: string;
          label: string | null;
          priority: number;
          row_version: number;
          source_node_id: string;
          target_node_id: string;
          updated_at: string;
          whiteboard_id: string;
        };
        Insert: {
          condition_json?: Json | null;
          created_at?: string;
          edge_id?: string;
          label?: string | null;
          priority?: number;
          row_version?: number;
          source_node_id: string;
          target_node_id: string;
          updated_at?: string;
          whiteboard_id: string;
        };
        Update: {
          condition_json?: Json | null;
          created_at?: string;
          edge_id?: string;
          label?: string | null;
          priority?: number;
          row_version?: number;
          source_node_id?: string;
          target_node_id?: string;
          updated_at?: string;
          whiteboard_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'fk_whiteboard_edges_source';
            columns: ['whiteboard_id', 'source_node_id'];
            isOneToOne: false;
            referencedRelation: 'whiteboard_nodes';
            referencedColumns: ['whiteboard_id', 'node_id'];
          },
          {
            foreignKeyName: 'fk_whiteboard_edges_target';
            columns: ['whiteboard_id', 'target_node_id'];
            isOneToOne: false;
            referencedRelation: 'whiteboard_nodes';
            referencedColumns: ['whiteboard_id', 'node_id'];
          },
          {
            foreignKeyName: 'whiteboard_edges_whiteboard_id_fkey';
            columns: ['whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'whiteboards';
            referencedColumns: ['whiteboard_id'];
          },
        ];
      };
      whiteboard_nodes: {
        Row: {
          created_at: string;
          node_data_json: Json;
          node_id: string;
          position_x: number;
          position_y: number;
          primitive_type: string;
          row_version: number;
          title: string;
          updated_at: string;
          whiteboard_id: string;
        };
        Insert: {
          created_at?: string;
          node_data_json?: Json;
          node_id?: string;
          position_x: number;
          position_y: number;
          primitive_type: string;
          row_version?: number;
          title: string;
          updated_at?: string;
          whiteboard_id: string;
        };
        Update: {
          created_at?: string;
          node_data_json?: Json;
          node_id?: string;
          position_x?: number;
          position_y?: number;
          primitive_type?: string;
          row_version?: number;
          title?: string;
          updated_at?: string;
          whiteboard_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'whiteboard_nodes_whiteboard_id_fkey';
            columns: ['whiteboard_id'];
            isOneToOne: false;
            referencedRelation: 'whiteboards';
            referencedColumns: ['whiteboard_id'];
          },
        ];
      };
      whiteboards: {
        Row: {
          created_at: string;
          last_reviewed_revision_no: number | null;
          owner_id: string;
          revision_no: number;
          status: string;
          title: string;
          updated_at: string;
          viewport_json: Json;
          whiteboard_id: string;
        };
        Insert: {
          created_at?: string;
          last_reviewed_revision_no?: number | null;
          owner_id: string;
          revision_no?: number;
          status?: string;
          title: string;
          updated_at?: string;
          viewport_json?: Json;
          whiteboard_id?: string;
        };
        Update: {
          created_at?: string;
          last_reviewed_revision_no?: number | null;
          owner_id?: string;
          revision_no?: number;
          status?: string;
          title?: string;
          updated_at?: string;
          viewport_json?: Json;
          whiteboard_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      abandon_execution_action: {
        Args: { p_execution_action_id: string; p_reconciliation: Json };
        Returns: Json;
      };
      activate_agent_version: {
        Args: { p_agent_id: string; p_agent_version_id: string };
        Returns: Json;
      };
      apply_comment_patch: {
        Args: { p_comment_id: string; p_expected_revision_no: number };
        Returns: Json;
      };
      complete_execution: {
        Args: {
          p_diff_summary: Json;
          p_execution_id: string;
          p_output_summary: Json;
          p_status: string;
        };
        Returns: Json;
      };
      complete_execution_action: {
        Args: {
          p_execution_action_id: string;
          p_provider_action_id: string;
          p_provider_response: Json;
          p_status: string;
        };
        Returns: Json;
      };
      create_agent: {
        Args: {
          p_deployment_key: string;
          p_name: string;
          p_whiteboard_id: string;
        };
        Returns: Json;
      };
      create_agent_version: {
        Args: {
          p_agent_id: string;
          p_parent_agent_version_id: string;
          p_spec_id: string;
        };
        Returns: Json;
      };
      create_execution: {
        Args: {
          p_agent_id: string;
          p_agent_version_id: string;
          p_business_key: string;
          p_case_key: string;
          p_idempotency_key: string;
          p_input_ref: Json;
          p_run_type: string;
          p_temporal_workflow_id: string;
        };
        Returns: Json;
      };
      create_manual_review_intake_execution: {
        Args: {
          p_agent_id: string;
          p_agent_version_id: string;
          p_candidates: Json;
          p_case_key: string;
          p_idempotency_key: string;
          p_input_ref: Json;
          p_message_ref: Json;
          p_reason: string;
        };
        Returns: Json;
      };
      create_review_session: {
        Args: {
          p_actor_user_id: string;
          p_expected_revision_no: number;
          p_model_name: string;
          p_reasoning_effort: string;
          p_snapshot: Json;
          p_snapshot_hash: string;
          p_whiteboard_id: string;
        };
        Returns: Json;
      };
      create_whiteboard: { Args: { p_title: string }; Returns: Json };
      dispatch_execution_action: {
        Args: { p_execution_action_id: string };
        Returns: Json;
      };
      fail_execution: {
        Args: { p_error: Json; p_execution_id: string };
        Returns: Json;
      };
      fail_review_session: {
        Args: {
          p_actor_user_id: string;
          p_error: Json;
          p_review_session_id: string;
        };
        Returns: Json;
      };
      finalize_review_session: {
        Args: {
          p_actor_user_id: string;
          p_findings: Json;
          p_review_session_id: string;
          p_summary: Json;
        };
        Returns: Json;
      };
      freeze_whiteboard_spec: {
        Args: {
          p_ack_blockers: boolean;
          p_ack_stale_review: boolean;
          p_actor_user_id: string;
          p_canvas_hash: string;
          p_canvas_json: Json;
          p_expected_revision_no: number;
          p_spec_hash: string;
          p_spec_json: Json;
          p_unresolved_comment_ids: string[];
          p_whiteboard_id: string;
        };
        Returns: Json;
      };
      mark_execution_action_for_reconciliation: {
        Args: { p_execution_action_id: string; p_reason: Json };
        Returns: Json;
      };
      reconcile_execution_action: {
        Args: {
          p_execution_action_id: string;
          p_provider_action_id: string;
          p_reconciliation: Json;
          p_status: string;
        };
        Returns: Json;
      };
      record_agent_commit: {
        Args: {
          p_actor_user_id: string;
          p_agent_version_id: string;
          p_build_manifest: Json;
          p_git_commit_sha: string;
        };
        Returns: Json;
      };
      record_explicit_assumption: {
        Args: { p_root_comment_id: string; p_text: string };
        Returns: Json;
      };
      record_policy_gap: {
        Args: {
          p_actor_user_id: string;
          p_agent_version_id: string;
          p_eval_execution_id: string;
          p_failure_key: string;
          p_snapshot: Json;
          p_snapshot_hash: string;
          p_source_revision_no: number;
          p_whiteboard_id: string;
        };
        Returns: Json;
      };
      reject_comment: {
        Args: { p_comment_id: string; p_reason: string };
        Returns: Json;
      };
      rename_whiteboard: {
        Args: {
          p_expected_revision_no: number;
          p_title: string;
          p_whiteboard_id: string;
        };
        Returns: Json;
      };
      reply_to_comment: {
        Args: { p_body: string; p_comment_id: string };
        Returns: Json;
      };
      reserve_execution_action: {
        Args: {
          p_action_type: string;
          p_execution_id: string;
          p_idempotency_key: string;
          p_request_payload: Json;
          p_step_execution_id: string;
        };
        Returns: Json;
      };
      save_whiteboard_delta: {
        Args: {
          p_edge_deletes?: string[];
          p_edge_upserts?: Json;
          p_expected_revision_no: number;
          p_node_deletes?: string[];
          p_node_upserts?: Json;
          p_viewport?: Json;
          p_whiteboard_id: string;
        };
        Returns: Json;
      };
      set_whiteboard_status: {
        Args: { p_status: string; p_whiteboard_id: string };
        Returns: Json;
      };
      start_execution: {
        Args: {
          p_execution_id: string;
          p_temporal_run_id: string;
          p_temporal_workflow_id: string;
        };
        Returns: Json;
      };
      transition_agent_version: {
        Args: { p_agent_version_id: string; p_status: string };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
