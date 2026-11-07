/**
 * Common field names of Splunk Common Information Model data models (a subset
 * of CIM 5.x, from the public CIM documentation). Used only when a data model
 * in the bundle does not list its own fields, for example when the CIM app is
 * a stub or was not extracted. Keys are data model names.
 */
export const CIM_REFERENCE_VERSION = "CIM 5.x (subset)";

const f = (s: string) => s.split(/\s+/).filter(Boolean);

export const CIM_FIELDS: Record<string, string[]> = {
  Authentication: f(`action app authentication_method authentication_service dest dest_bunit dest_category dest_nt_domain
    dest_priority duration reason response_time signature signature_id src src_bunit src_category src_nt_domain src_priority
    src_user src_user_bunit src_user_category src_user_id src_user_priority src_user_role src_user_type user user_bunit
    user_category user_id user_priority user_role user_type vendor_account`),
  Network_Traffic: f(`action app bytes bytes_in bytes_out channel dest dest_interface dest_ip dest_mac dest_port dest_translated_ip
    dest_translated_port dest_zone direction duration dvc dvc_ip flow_id icmp_code icmp_type packets packets_in packets_out
    process_id protocol protocol_version response_time rule session_id src src_interface src_ip src_mac src_port
    src_translated_ip src_translated_port src_zone ssid tcp_flag transport ttl user vendor_account vendor_product vlan wifi`),
  Web: f(`action app bytes bytes_in bytes_out cached category cookie dest dest_port duration error_code http_content_type
    http_method http_referrer http_referrer_domain http_user_agent http_user_agent_length operation response_time site src
    status storage_name uri_path uri_query url url_domain url_length user vendor_product`),
  Change: f(`action change_type command dest dvc image_id object object_attrs object_category object_id object_path result
    result_id src status user user_agent user_name user_type vendor_account vendor_product vendor_region`),
  Endpoint: f(`action dest original_file_name os parent_process parent_process_exec parent_process_guid parent_process_id
    parent_process_name parent_process_path process process_current_directory process_exec process_guid process_hash
    process_id process_integrity_level process_name process_path user user_id vendor_product`),
  Network_Resolution: f(`additional_answer_count answer answer_count authority_answer_count dest dest_port duration
    message_type name query query_count query_type record_type reply_code reply_code_id response_time src src_port
    transaction_id transport ttl vendor_product`),
  Intrusion_Detection: f(`action category dest dest_ip dest_port dvc file_hash file_name file_path ids_type severity
    severity_id signature signature_id src src_ip src_port transport user vendor_product`),
  Malware: f(`action category date dest file_hash file_name file_path signature signature_id src src_user url user vendor_product`),
  Email: f(`action delay dest duration file_hash file_name file_size internal_message_id message_id message_info orig_dest
    orig_recipient orig_src process process_id protocol recipient recipient_count recipient_domain recipient_status
    response_time retries return_addr size src src_user src_user_domain status_code subject url user vendor_product xdelay xref`),
};
