variable "app_name" {
  description = "Name of the application (used for resource naming and tagging)"
  type        = string
}

variable "environment" {
  description = "Deployment environment (e.g. dev, staging, production)"
  type        = string
}

variable "alb_arn" {
  description = "ARN of the Application Load Balancer to associate the WAF with"
  type        = string
}

variable "rate_limit" {
  description = "Maximum number of requests allowed per 5-minute period per IP address"
  type        = number
  default     = 2000
}

variable "blocked_countries" {
  description = "List of two-letter ISO 3166-1 country codes to block (e.g. [\"RU\", \"CN\"]). Leave empty to disable geo-blocking."
  type        = list(string)
  default     = []
}

variable "suspicious_user_agents" {
  description = "List of regex patterns matching suspicious user-agent strings to block"
  type        = list(string)
  default = [
    "(?i)sqlmap",
    "(?i)nikto",
    "(?i)nessus",
    "(?i)dirbuster",
    "(?i)havij",
    "(?i)w3af",
    "(?i)nmap",
    "(?i)masscan",
    "(?i)zgrab",
  ]
}

variable "tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}
