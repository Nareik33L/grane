view: orders {
  sql_table_name: orders ;;

  dimension: net_amount {
    type: number
    sql: ${TABLE}.net_amount ;;
  }

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }

  dimension: status {
    type: string
    sql: ${TABLE}.status ;;
  }

  dimension_group: completed {
    type: time
    sql: ${TABLE}.completed_at ;;
  }

  measure: revenue {
    type: sum
    sql: ${TABLE}.net_amount ;;
    filters: [status: "completed"]
  }

  measure: count {
    type: count
  }
}

view: customers {
  sql_table_name: customers ;;

  dimension: id {
    primary_key: yes
    type: number
    sql: ${TABLE}.id ;;
  }

  dimension: country {
    type: string
    sql: ${TABLE}.country ;;
  }
}

explore: orders {
  join: customers {
    sql_on: ${orders.customer_id} = ${customers.id} ;;
    relationship: many_to_one
  }
}
