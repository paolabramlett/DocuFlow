export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      audit_events: {
        Row: {
          action: string
          actor_auth_user_id: string | null
          actor_grant_id: string | null
          actor_kind: string
          case_id: string | null
          created_at: string
          id: string
          metadata: Json
          organization_id: string
          target_id: string | null
          target_type: string
        }
        Insert: {
          action: string
          actor_auth_user_id?: string | null
          actor_grant_id?: string | null
          actor_kind: string
          case_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          organization_id: string
          target_id?: string | null
          target_type: string
        }
        Update: {
          action?: string
          actor_auth_user_id?: string | null
          actor_grant_id?: string | null
          actor_kind?: string
          case_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          organization_id?: string
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      blueprint_participant_templates: {
        Row: {
          blueprint_id: string
          created_at: string
          display_name: string
          id: string
          organization_id: string
          position: number
          role_key: string
        }
        Insert: {
          blueprint_id: string
          created_at?: string
          display_name: string
          id?: string
          organization_id: string
          position: number
          role_key: string
        }
        Update: {
          blueprint_id?: string
          created_at?: string
          display_name?: string
          id?: string
          organization_id?: string
          position?: number
          role_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "blueprint_participant_templat_blueprint_id_organization_id_fkey"
            columns: ["blueprint_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "blueprints"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "blueprint_participant_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      blueprint_stages: {
        Row: {
          blueprint_id: string
          completion_mode: string
          created_at: string
          id: string
          name: string
          organization_id: string
          position: number
        }
        Insert: {
          blueprint_id: string
          completion_mode?: string
          created_at?: string
          id?: string
          name: string
          organization_id: string
          position: number
        }
        Update: {
          blueprint_id?: string
          completion_mode?: string
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "blueprint_stages_blueprint_id_organization_id_fkey"
            columns: ["blueprint_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "blueprints"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "blueprint_stages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      blueprints: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_platform_template: boolean
          name: string
          organization_id: string
          requirement_definitions: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_platform_template?: boolean
          name: string
          organization_id: string
          requirement_definitions?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_platform_template?: boolean
          name?: string
          organization_id?: string
          requirement_definitions?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blueprints_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      case_access_grants: {
        Row: {
          action_required_notified_at: string | null
          auth_user_id: string | null
          case_id: string
          created_at: string
          expires_at: string | null
          id: string
          invitation_expires_at: string
          invitation_last_error: string | null
          invitation_sent_at: string | null
          invitation_status: string
          invitation_token_hash: string
          invited_email: string
          organization_id: string
          otp_failed_attempts: number
          otp_last_sent_at: string | null
          otp_locked_until: string | null
          participant_id: string
          permission: string
          permission_before_closure: string | null
          revoked_at: string | null
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          action_required_notified_at?: string | null
          auth_user_id?: string | null
          case_id: string
          created_at?: string
          expires_at?: string | null
          id?: string
          invitation_expires_at?: string
          invitation_last_error?: string | null
          invitation_sent_at?: string | null
          invitation_status?: string
          invitation_token_hash: string
          invited_email: string
          organization_id: string
          otp_failed_attempts?: number
          otp_last_sent_at?: string | null
          otp_locked_until?: string | null
          participant_id: string
          permission?: string
          permission_before_closure?: string | null
          revoked_at?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          action_required_notified_at?: string | null
          auth_user_id?: string | null
          case_id?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          invitation_expires_at?: string
          invitation_last_error?: string | null
          invitation_sent_at?: string | null
          invitation_status?: string
          invitation_token_hash?: string
          invited_email?: string
          organization_id?: string
          otp_failed_attempts?: number
          otp_last_sent_at?: string | null
          otp_locked_until?: string | null
          participant_id?: string
          permission?: string
          permission_before_closure?: string | null
          revoked_at?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "case_access_grants_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "case_access_grants_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_access_grants_participant_fk"
            columns: ["participant_id", "case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "case_participants"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
        ]
      }
      case_participants: {
        Row: {
          case_id: string
          client_id: string
          created_at: string
          id: string
          organization_id: string
          role_label: string
          updated_at: string
        }
        Insert: {
          case_id: string
          client_id: string
          created_at?: string
          id?: string
          organization_id: string
          role_label: string
          updated_at?: string
        }
        Update: {
          case_id?: string
          client_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          role_label?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_participants_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "case_participants_client_id_organization_id_fkey"
            columns: ["client_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "case_participants_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      case_stages: {
        Row: {
          activated_at: string | null
          case_id: string
          completed_at: string | null
          completed_by_auth_user_id: string | null
          completion_mode: string
          created_at: string
          id: string
          name: string
          organization_id: string
          position: number
          status: string
        }
        Insert: {
          activated_at?: string | null
          case_id: string
          completed_at?: string | null
          completed_by_auth_user_id?: string | null
          completion_mode?: string
          created_at?: string
          id?: string
          name: string
          organization_id: string
          position: number
          status?: string
        }
        Update: {
          activated_at?: string | null
          case_id?: string
          completed_at?: string | null
          completed_by_auth_user_id?: string | null
          completion_mode?: string
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          position?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_stages_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "case_stages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      cases: {
        Row: {
          client_closing_note: string | null
          client_id: string
          closed_at: string | null
          closed_by_auth_user_id: string | null
          created_at: string
          id: string
          organization_id: string
          origin_blueprint_id: string | null
          state: string
          title: string
          updated_at: string
        }
        Insert: {
          client_closing_note?: string | null
          client_id: string
          closed_at?: string | null
          closed_by_auth_user_id?: string | null
          created_at?: string
          id?: string
          organization_id: string
          origin_blueprint_id?: string | null
          state?: string
          title: string
          updated_at?: string
        }
        Update: {
          client_closing_note?: string | null
          client_id?: string
          closed_at?: string | null
          closed_by_auth_user_id?: string | null
          created_at?: string
          id?: string
          organization_id?: string
          origin_blueprint_id?: string | null
          state?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cases_client_id_organization_id_fkey"
            columns: ["client_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "cases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_origin_blueprint_id_fkey"
            columns: ["origin_blueprint_id"]
            isOneToOne: false
            referencedRelation: "blueprints"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          auth_user_id: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
          created_at?: string
          email: string
          full_name: string
          id?: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_upload_sessions: {
        Row: {
          bucket: string
          case_id: string
          claimed_at: string | null
          completed_at: string | null
          completed_document_id: string | null
          created_at: string
          declared_content_type: string
          declared_size_bytes: number
          expires_at: string
          id: string
          organization_id: string
          original_file_name: string
          participant_id: string
          requirement_id: string
          reserved_document_id: string
          signed_url_expires_at: string
          status: string
          storage_path: string
        }
        Insert: {
          bucket?: string
          case_id: string
          claimed_at?: string | null
          completed_at?: string | null
          completed_document_id?: string | null
          created_at?: string
          declared_content_type: string
          declared_size_bytes: number
          expires_at: string
          id?: string
          organization_id: string
          original_file_name: string
          participant_id: string
          requirement_id: string
          reserved_document_id: string
          signed_url_expires_at: string
          status?: string
          storage_path: string
        }
        Update: {
          bucket?: string
          case_id?: string
          claimed_at?: string | null
          completed_at?: string | null
          completed_document_id?: string | null
          created_at?: string
          declared_content_type?: string
          declared_size_bytes?: number
          expires_at?: string
          id?: string
          organization_id?: string
          original_file_name?: string
          participant_id?: string
          requirement_id?: string
          reserved_document_id?: string
          signed_url_expires_at?: string
          status?: string
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_upload_sessions_completed_document_id_fkey"
            columns: ["completed_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_upload_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          case_id: string
          content_type: string
          created_at: string
          file_name: string
          id: string
          organization_id: string
          requirement_id: string
          size_bytes: number
          storage_path: string
          updated_at: string
          uploaded_by_auth_user_id: string | null
        }
        Insert: {
          case_id: string
          content_type: string
          created_at?: string
          file_name: string
          id?: string
          organization_id: string
          requirement_id: string
          size_bytes: number
          storage_path: string
          updated_at?: string
          uploaded_by_auth_user_id?: string | null
        }
        Update: {
          case_id?: string
          content_type?: string
          created_at?: string
          file_name?: string
          id?: string
          organization_id?: string
          requirement_id?: string
          size_bytes?: number
          storage_path?: string
          updated_at?: string
          uploaded_by_auth_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_requirement_id_case_id_organization_id_fkey"
            columns: ["requirement_id", "case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "active_requirements"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
          {
            foreignKeyName: "documents_requirement_id_case_id_organization_id_fkey"
            columns: ["requirement_id", "case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "requirements"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
        ]
      }
      members: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          role: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          access_retention_days: number
          created_at: string
          grant_reactivation_days: number
          id: string
          industry: string
          name: string
          reminder_first_delay_days: number
          reminder_interval_days: number
          reminder_max_count: number
          updated_at: string
        }
        Insert: {
          access_retention_days?: number
          created_at?: string
          grant_reactivation_days?: number
          id?: string
          industry: string
          name: string
          reminder_first_delay_days?: number
          reminder_interval_days?: number
          reminder_max_count?: number
          updated_at?: string
        }
        Update: {
          access_retention_days?: number
          created_at?: string
          grant_reactivation_days?: number
          id?: string
          industry?: string
          name?: string
          reminder_first_delay_days?: number
          reminder_interval_days?: number
          reminder_max_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      reminder_deliveries: {
        Row: {
          attempt_count: number
          cadence_window: number
          case_id: string
          channel: string
          destination: string | null
          failed_at: string | null
          grant_id: string
          id: string
          last_error: string | null
          organization_id: string
          participant_id: string | null
          queued_at: string
          sent_at: string | null
          status: string
        }
        Insert: {
          attempt_count?: number
          cadence_window: number
          case_id: string
          channel?: string
          destination?: string | null
          failed_at?: string | null
          grant_id: string
          id?: string
          last_error?: string | null
          organization_id: string
          participant_id?: string | null
          queued_at?: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          attempt_count?: number
          cadence_window?: number
          case_id?: string
          channel?: string
          destination?: string | null
          failed_at?: string | null
          grant_id?: string
          id?: string
          last_error?: string | null
          organization_id?: string
          participant_id?: string | null
          queued_at?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminder_deliveries_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "reminder_deliveries_grant_id_organization_id_fkey"
            columns: ["grant_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "case_access_grants"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "reminder_deliveries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminder_deliveries_participant_fk"
            columns: ["participant_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "case_participants"
            referencedColumns: ["id", "organization_id"]
          },
        ]
      }
      requirements: {
        Row: {
          case_id: string
          config: Json
          created_at: string
          deleted_at: string | null
          id: string
          instructions: string | null
          label: string
          organization_id: string
          participant_id: string | null
          position: number
          reopen_reason: string | null
          reopened_from_requirement_id: string | null
          stage_id: string | null
          status: string
          superseded_at: string | null
          superseded_by_requirement_id: string | null
          type: string
          updated_at: string
        }
        Insert: {
          case_id: string
          config?: Json
          created_at?: string
          deleted_at?: string | null
          id?: string
          instructions?: string | null
          label: string
          organization_id: string
          participant_id?: string | null
          position: number
          reopen_reason?: string | null
          reopened_from_requirement_id?: string | null
          stage_id?: string | null
          status?: string
          superseded_at?: string | null
          superseded_by_requirement_id?: string | null
          type: string
          updated_at?: string
        }
        Update: {
          case_id?: string
          config?: Json
          created_at?: string
          deleted_at?: string | null
          id?: string
          instructions?: string | null
          label?: string
          organization_id?: string
          participant_id?: string | null
          position?: number
          reopen_reason?: string | null
          reopened_from_requirement_id?: string | null
          stage_id?: string | null
          status?: string
          superseded_at?: string | null
          superseded_by_requirement_id?: string | null
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "requirements_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "requirements_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirements_participant_fk"
            columns: ["participant_id", "case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "case_participants"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
          {
            foreignKeyName: "requirements_reopened_from_requirement_id_fkey"
            columns: ["reopened_from_requirement_id"]
            isOneToOne: false
            referencedRelation: "active_requirements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirements_reopened_from_requirement_id_fkey"
            columns: ["reopened_from_requirement_id"]
            isOneToOne: false
            referencedRelation: "requirements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirements_stage_fk"
            columns: ["stage_id", "case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "case_stages"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
          {
            foreignKeyName: "requirements_superseded_by_fk"
            columns: [
              "superseded_by_requirement_id",
              "case_id",
              "organization_id",
            ]
            isOneToOne: false
            referencedRelation: "active_requirements"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
          {
            foreignKeyName: "requirements_superseded_by_fk"
            columns: [
              "superseded_by_requirement_id",
              "case_id",
              "organization_id",
            ]
            isOneToOne: false
            referencedRelation: "requirements"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
        ]
      }
      reviews: {
        Row: {
          case_id: string
          created_at: string
          decision: string
          document_id: string
          id: string
          organization_id: string
          reason: string | null
          reviewed_by_auth_user_id: string | null
        }
        Insert: {
          case_id: string
          created_at?: string
          decision: string
          document_id: string
          id?: string
          organization_id: string
          reason?: string | null
          reviewed_by_auth_user_id?: string | null
        }
        Update: {
          case_id?: string
          created_at?: string
          decision?: string
          document_id?: string
          id?: string
          organization_id?: string
          reason?: string | null
          reviewed_by_auth_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reviews_document_id_organization_id_fkey"
            columns: ["document_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "reviews_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      signup_attempts: {
        Row: {
          email: string
          last_attempted_at: string
        }
        Insert: {
          email: string
          last_attempted_at?: string
        }
        Update: {
          email?: string
          last_attempted_at?: string
        }
        Relationships: []
      }
      staff_notifications: {
        Row: {
          acknowledged_at: string | null
          case_id: string
          created_at: string
          id: string
          organization_id: string
          reason: string
          target_id: string | null
          target_type: string
        }
        Insert: {
          acknowledged_at?: string | null
          case_id: string
          created_at?: string
          id?: string
          organization_id: string
          reason: string
          target_id?: string | null
          target_type: string
        }
        Update: {
          acknowledged_at?: string | null
          case_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          reason?: string
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_notifications_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "staff_notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      active_requirements: {
        Row: {
          case_id: string | null
          config: Json | null
          created_at: string | null
          id: string | null
          instructions: string | null
          label: string | null
          organization_id: string | null
          participant_id: string | null
          position: number | null
          stage_id: string | null
          status: string | null
          type: string | null
          updated_at: string | null
        }
        Insert: {
          case_id?: string | null
          config?: Json | null
          created_at?: string | null
          id?: string | null
          instructions?: string | null
          label?: string | null
          organization_id?: string | null
          participant_id?: string | null
          position?: number | null
          stage_id?: string | null
          status?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Update: {
          case_id?: string | null
          config?: Json | null
          created_at?: string | null
          id?: string | null
          instructions?: string | null
          label?: string | null
          organization_id?: string | null
          participant_id?: string | null
          position?: number | null
          stage_id?: string | null
          status?: string | null
          type?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "requirements_case_id_organization_id_fkey"
            columns: ["case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id", "organization_id"]
          },
          {
            foreignKeyName: "requirements_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirements_participant_fk"
            columns: ["participant_id", "case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "case_participants"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
          {
            foreignKeyName: "requirements_stage_fk"
            columns: ["stage_id", "case_id", "organization_id"]
            isOneToOne: false
            referencedRelation: "case_stages"
            referencedColumns: ["id", "case_id", "organization_id"]
          },
        ]
      }
    }
    Functions: {
      advance_case_stage: {
        Args: { p_case_id: string }
        Returns: {
          participant_id: string
        }[]
      }
      assign_requirement_stage: {
        Args: { p_requirement_id: string; p_stage_id: string }
        Returns: undefined
      }
      cancel_upload_session: {
        Args: { p_session_id: string }
        Returns: undefined
      }
      claim_signup_attempt: {
        Args: { cooldown_seconds: number; signup_email: string }
        Returns: boolean
      }
      claim_upload_session_for_finalize: {
        Args: { p_session_id: string }
        Returns: {
          already_completed: boolean
          completed_document_id: string
        }[]
      }
      close_case: {
        Args: { p_case_id: string; p_closing_note?: string; p_outcome: string }
        Returns: {
          client_closing_note: string | null
          client_id: string
          closed_at: string | null
          closed_by_auth_user_id: string | null
          created_at: string
          id: string
          organization_id: string
          origin_blueprint_id: string | null
          state: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "cases"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      complete_onboarding: {
        Args: { organization_industry: string; organization_name: string }
        Returns: string
      }
      create_case: {
        Args: {
          case_title: string
          from_blueprint_id?: string
          target_client_id: string
          target_organization_id: string
        }
        Returns: string
      }
      create_organization: {
        Args: { organization_industry: string; organization_name: string }
        Returns: string
      }
      create_upload_session: {
        Args: {
          p_declared_content_type: string
          p_declared_size_bytes: number
          p_original_file_name: string
          p_requirement_id: string
          p_signed_url_expires_at: string
        }
        Returns: {
          reserved_document_id: string
          session_id: string
          storage_path: string
        }[]
      }
      emit_participant_invitation: {
        Args: { p_participant_id: string }
        Returns: {
          case_id: string
          invited_email: string
          organization_id: string
          token: string
        }[]
      }
      finalize_document_upload: {
        Args: {
          p_session_id: string
          p_verified_content_type: string
          p_verified_size_bytes: number
        }
        Returns: string
      }
      list_actionable_requirement_ids: {
        Args: { p_participant_id: string }
        Returns: string[]
      }
      list_participant_stage_context: {
        Args: { p_participant_id: string }
        Returns: {
          requirement_id: string
          stage_name: string
          stage_status: string
        }[]
      }
      org_members_with_email: {
        Args: { target_organization_id: string }
        Returns: {
          created_at: string
          email: string
          id: string
          role: string
          user_id: string
        }[]
      }
      reopen_case: {
        Args: { p_case_id: string }
        Returns: {
          participant_id: string
        }[]
      }
      reopen_requirement: {
        Args: { p_reason: string; p_requirement_id: string }
        Returns: string
      }
      save_blueprint: {
        Args: {
          blueprint_description?: string
          blueprint_name: string
          participant_templates: Json
          requirement_definitions: Json
          stages: Json
          target_blueprint_id?: string
          target_organization_id: string
        }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

