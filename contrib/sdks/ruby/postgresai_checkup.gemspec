# frozen_string_literal: true

require_relative "lib/postgresai_checkup/version"

Gem::Specification.new do |spec|
  spec.name = "postgresai_checkup"
  spec.version = PostgresAI::VERSION
  spec.authors = ["PostgresAI"]
  spec.email = ["team@postgres.ai"]

  spec.summary = "PostgreSQL health checks - unused indexes, bloat, and more"
  spec.description = <<~DESC
    A lightweight library for running PostgreSQL health checks directly from Ruby.
    Works standalone or integrates with Rails/ActiveRecord.

    Checks include:
    - H002: Unused indexes
    - H001: Invalid indexes
    - H004: Redundant indexes
    - F004: Table bloat estimation
  DESC
  spec.homepage = "https://github.com/postgres-ai/postgresai"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 2.7.0"

  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = "https://github.com/postgres-ai/postgresai"
  spec.metadata["changelog_uri"] = "https://github.com/postgres-ai/postgresai/blob/main/CHANGELOG.md"

  spec.files = Dir.chdir(__dir__) do
    `git ls-files -z`.split("\x0").reject do |f|
      (f == __FILE__) || f.match(%r{\A(?:(?:bin|test|spec|features)/|\.(?:git|travis|circleci)|appveyor)})
    end
  end

  spec.require_paths = ["lib"]

  spec.add_dependency "pg", ">= 1.0"

  spec.add_development_dependency "bundler", "~> 2.0"
  spec.add_development_dependency "rake", "~> 13.0"
  spec.add_development_dependency "rspec", "~> 3.0"
end
