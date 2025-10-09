%{ if length(monitoring_instances) > 0 ~}
%{ for instance in monitoring_instances ~}
- name: ${instance.name}
  conn_str: ${instance.conn_str}
  preset_metrics: full
  custom_metrics:
  is_enabled: true
  group: default
  custom_tags:
    env: ${instance.environment}
    cluster: ${instance.cluster}
    node_name: ${instance.node_name}
    sink_type: ~sink_type~

%{ endfor ~}
%{ endif ~}
%{ if enable_demo_db ~}
- name: demo-db
  conn_str: postgresql://postgres:postgres@target-db:5432/postgres
  preset_metrics: full
  custom_metrics:
  is_enabled: true
  group: default
  custom_tags:
    env: demo
    cluster: demo
    node_name: demo
    sink_type: ~sink_type~
%{ endif ~}

