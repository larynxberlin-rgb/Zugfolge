\pset tuples_only on
\pset format unaligned
SELECT 'zugfolge_world_projection=' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM zugfolge_world_projection t), '[]');
SELECT 'zugfolge_admin_capability=' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM zugfolge_admin_capability t), '[]');
SELECT 'zugfolge_admin_request=' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM zugfolge_admin_request t), '[]');
SELECT 'zugfolge_alpha_invitation=' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM zugfolge_alpha_invitation t), '[]');
SELECT 'zugfolge_feedback=' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM zugfolge_feedback t), '[]');
SELECT 'zugfolge_projection_receipt=' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM zugfolge_projection_receipt t), '[]');
SELECT 'ir_attachment=' || COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM ir_attachment t WHERE t.res_model LIKE 'zugfolge.%'), '[]');
