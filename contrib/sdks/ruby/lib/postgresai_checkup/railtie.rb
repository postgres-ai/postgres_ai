# frozen_string_literal: true

require "rails/railtie"

module PostgresAI
  class Railtie < Rails::Railtie
    railtie_name :postgresai

    rake_tasks do
      load File.expand_path("tasks/checkup.rake", __dir__)
    end
  end
end
