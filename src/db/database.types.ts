// ─────────────────────────────────────────────────────────────────────
// SpamSlayer — Supabase generated types
// Source: migration 001_initial_schema on project vwfnmcfvaasrouiiejos
// Generated: 2026-04-18
//
// DO NOT EDIT BY HAND. Regenerate with the Supabase MCP
// `generate_typescript_types` tool (or CLI `supabase gen types typescript`)
// after each migration.
// ─────────────────────────────────────────────────────────────────────

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      calls: {
        Row: {
          call_date: string;
          call_sid: string;
          call_time: string;
          call_type: string;
          created_at: string;
          id: string;
          offender_id: string;
          recording_url: string | null;
          transcript_snippet: string;
          user_id: string;
        };
        Insert: {
          call_date: string;
          call_sid: string;
          call_time: string;
          call_type?: string;
          created_at?: string;
          id?: string;
          offender_id: string;
          recording_url?: string | null;
          transcript_snippet?: string;
          user_id: string;
        };
        Update: {
          call_date?: string;
          call_sid?: string;
          call_time?: string;
          call_type?: string;
          created_at?: string;
          id?: string;
          offender_id?: string;
          recording_url?: string | null;
          transcript_snippet?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calls_offender_id_fkey";
            columns: ["offender_id"];
            isOneToOne: false;
            referencedRelation: "offenders";
            referencedColumns: ["id"];
          }
        ];
      };
      filings: {
        Row: {
          case_ref: string;
          court_name: string | null;
          court_state: string | null;
          damages_claimed: number;
          generated_at: string;
          id: string;
          offender_id: string;
          package_data: Json | null;
          user_id: string;
          willful: boolean;
        };
        Insert: {
          case_ref: string;
          court_name?: string | null;
          court_state?: string | null;
          damages_claimed: number;
          generated_at?: string;
          id?: string;
          offender_id: string;
          package_data?: Json | null;
          user_id: string;
          willful?: boolean;
        };
        Update: {
          case_ref?: string;
          court_name?: string | null;
          court_state?: string | null;
          damages_claimed?: number;
          generated_at?: string;
          id?: string;
          offender_id?: string;
          package_data?: Json | null;
          user_id?: string;
          willful?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "filings_offender_id_fkey";
            columns: ["offender_id"];
            isOneToOne: false;
            referencedRelation: "offenders";
            referencedColumns: ["id"];
          }
        ];
      };
      offenders: {
        Row: {
          actionable: boolean;
          caller_names: string[];
          company_name: string | null;
          created_at: string;
          damages_estimate: number;
          demand_letter_date: string | null;
          demand_letter_sent: boolean;
          filed_at: string | null;
          filed_case_ref: string | null;
          first_call_date: string;
          id: string;
          last_call_date: string;
          normalized_number: string;
          parent_offender_id: string | null;
          purpose: string | null;
          raw_numbers: string[];
          updated_at: string;
          user_id: string;
          willful: boolean;
        };
        Insert: {
          actionable?: boolean;
          caller_names?: string[];
          company_name?: string | null;
          created_at?: string;
          damages_estimate?: number;
          demand_letter_date?: string | null;
          demand_letter_sent?: boolean;
          filed_at?: string | null;
          filed_case_ref?: string | null;
          first_call_date: string;
          id?: string;
          last_call_date: string;
          normalized_number: string;
          parent_offender_id?: string | null;
          purpose?: string | null;
          raw_numbers?: string[];
          updated_at?: string;
          user_id: string;
          willful?: boolean;
        };
        Update: {
          actionable?: boolean;
          caller_names?: string[];
          company_name?: string | null;
          created_at?: string;
          damages_estimate?: number;
          demand_letter_date?: string | null;
          demand_letter_sent?: boolean;
          filed_at?: string | null;
          filed_case_ref?: string | null;
          first_call_date?: string;
          id?: string;
          last_call_date?: string;
          normalized_number?: string;
          parent_offender_id?: string | null;
          purpose?: string | null;
          raw_numbers?: string[];
          updated_at?: string;
          user_id?: string;
          willful?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "offenders_parent_offender_id_fkey";
            columns: ["parent_offender_id"];
            isOneToOne: false;
            referencedRelation: "offenders";
            referencedColumns: ["id"];
          }
        ];
      };
      user_config: {
        Row: {
          address: string | null;
          city: string | null;
          court_name: string | null;
          court_parish_or_county: string | null;
          court_state: string | null;
          dnc_registration_date: string | null;
          email: string | null;
          full_name: string | null;
          line_type: string | null;
          phone: string | null;
          state: string | null;
          updated_at: string;
          user_id: string;
          zip: string | null;
        };
        Insert: {
          address?: string | null;
          city?: string | null;
          court_name?: string | null;
          court_parish_or_county?: string | null;
          court_state?: string | null;
          dnc_registration_date?: string | null;
          email?: string | null;
          full_name?: string | null;
          line_type?: string | null;
          phone?: string | null;
          state?: string | null;
          updated_at?: string;
          user_id: string;
          zip?: string | null;
        };
        Update: {
          address?: string | null;
          city?: string | null;
          court_name?: string | null;
          court_parish_or_county?: string | null;
          court_state?: string | null;
          dnc_registration_date?: string | null;
          email?: string | null;
          full_name?: string | null;
          line_type?: string | null;
          phone?: string | null;
          state?: string | null;
          updated_at?: string;
          user_id?: string;
          zip?: string | null;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
