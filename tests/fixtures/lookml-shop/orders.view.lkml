view: orders {
  sql_table_name: orders ;;

  dimension: id {
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
